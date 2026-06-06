import { parseSync } from '@babel/core'
import * as t from '@babel/types'
import { describe, expect, it, vi } from 'vitest'

import { buildHIR } from '../src/ir/build-hir'
import { lowerHIRWithRegions } from '../src/ir/codegen'
import { HIRError } from '../src/ir/hir'
import { type FictCompilerOptions } from '../src/index'
import { transform } from './test-utils'

const run = (source: string, options?: FictCompilerOptions) => {
  return transform(source, options)
}

const parseFile = (code: string) =>
  parseSync(code, {
    filename: 'module.tsx',
    parserOpts: { sourceType: 'module', plugins: ['typescript', 'jsx'] },
    ast: true,
    code: false,
    cloneInputAst: false,
  })!

describe('Error/Cycle Protection', () => {
  it('detects simple cycle: a -> b -> a', () => {
    const source = `
      import { $state } from 'fict'
      function Component() {
        const count = $state(0)
        const a = count + b
        const b = count + a
        return a + b
      }
    `
    // Should throw compiler error
    expect(() => run(source)).toThrow(/Detected cyclic derived dependency/)
  })

  it('detects self-reference: a -> a', () => {
    const source = `
      import { $state } from 'fict'
      function Component() {
        const count = $state(0)
        const a = count + a
        return a
      }
    `
    expect(() => run(source)).toThrow(/Detected cyclic derived dependency/)
  })

  it('detects long cycle: a -> b -> c -> a', () => {
    const source = `
      import { $state } from 'fict'
      function Component() {
        const count = $state(0)
        const a = count + b
        const b = c + 1
        const c = a + 1
        return a + b + c
      }
    `
    expect(() => run(source)).toThrow(/Detected cyclic derived dependency/)
  })

  it('does not let FICT_DEBUG=all trigger the internal cycle throw trap', () => {
    const source = `
      import { $state } from 'fict'
      function Component() {
        const count = $state(0)
        const a = count + b
        const b = count + a
        return a + b
      }
    `
    const prevFictDebug = process.env.FICT_DEBUG
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    process.env.FICT_DEBUG = 'all'
    try {
      expect(() => run(source)).toThrow(/Detected cyclic derived dependency/)
      expect(() => run(source)).not.toThrow(/cycle check invoked/)
    } finally {
      logSpy.mockRestore()
      if (prevFictDebug === undefined) {
        delete process.env.FICT_DEBUG
      } else {
        process.env.FICT_DEBUG = prevFictDebug
      }
    }
  })

  it('surfaces cycle detection as HIRError during lowering', () => {
    const source = `
      import { $state } from 'fict'
      function Component() {
        const count = $state(0)
        const a = count + b
        const b = count + a
        return a + b
      }
    `
    const hir = buildHIR(parseFile(source))

    try {
      lowerHIRWithRegions(hir, t, {
        filename: 'module.tsx',
        fineGrainedDom: true,
        strictGuarantee: false,
      })
      throw new Error('expected lowerHIRWithRegions to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(HIRError)
      const hirError = error as HIRError
      expect(hirError.code).toBe('BUILD_ERROR')
      expect(hirError.message).toContain('Detected cyclic derived dependency')
      expect(hirError.context?.file).toBe('module.tsx')
    }
  })

  it('allows linear dependencies: a -> b -> c', () => {
    const source = `
      import { $state } from 'fict'
      function Component() {
        const count = $state(0)
        const a = count + 1
        const b = a + 1
        const c = b + 1
        console.log(c)
        return c
      }
    `
    const output = run(source)
    expect(output).toContain('const c =')
    expect(output).not.toContain('const c = c')
  })

  it('ignores nested function parameters that shadow derived bindings', () => {
    const cases = [
      `
        const wrap = (x) => x
        const x = wrap(source)
      `,
      `
        const wrap = function (x) {
          return x
        }
        const x = wrap(source)
      `,
      `
        const obj = {
          m(x) {
            return x
          },
        }
        const x = obj.m(source)
      `,
      `
        const wrap = ({ x }) => x
        const x = wrap({ x: source })
      `,
    ]

    for (const body of cases) {
      const source = `
        import { $state } from 'fict'
        function Component() {
          const source = $state(1)
          ${body}
          return <div>{x}</div>
        }
      `

      expect(() => run(source)).not.toThrow(/Detected cyclic derived dependency/)
    }
  })
})
