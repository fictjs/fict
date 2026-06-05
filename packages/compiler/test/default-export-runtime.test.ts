import { describe, expect, it } from 'vitest'

import * as runtimeInternal from '../../runtime/src/internal'

import { transformCommonJS } from './test-utils'

function compileModule(source: string): Record<string, unknown> {
  const output = transformCommonJS(source, {
    dev: false,
    emitModuleMetadata: false,
    strictGuarantee: false,
    optimize: true,
  })

  const module: { exports: Record<string, unknown> } = { exports: {} }
  const wrapped = new Function('require', 'module', 'exports', output)
  wrapped(
    (id: string) => {
      if (id === '@fictjs/runtime/internal' || id === 'fict/internal' || id === 'fict') {
        return runtimeInternal
      }
      throw new Error(`Unexpected import in default export test: ${id}`)
    },
    module,
    module.exports,
  )
  return module.exports
}

describe('anonymous default function exports', () => {
  it('does not leak the internal default function name', () => {
    const exports = compileModule(`
      export default function() {
        return 1
      }
    `)

    const fn = exports.default as Function
    expect(fn.name).not.toBe('__default')
  })

  it('preserves anonymous async default functions', () => {
    const exports = compileModule(`
      export default async function() {
        return 1
      }
    `)

    const fn = exports.default as Function
    expect(fn.name).not.toBe('__default')
    expect(fn.constructor.name).toBe('AsyncFunction')
  })

  it('preserves anonymous generator default functions', () => {
    const exports = compileModule(`
      export default function*() {
        yield 1
      }
    `)

    const fn = exports.default as Function
    expect(fn.name).not.toBe('__default')
    expect(fn.constructor.name).toBe('GeneratorFunction')
  })

  it('does not leak the internal name for transformed component defaults', () => {
    const exports = compileModule(`
      import { $state } from 'fict'

      export default function() {
        let count = $state(0)
        return <div>{count}</div>
      }
    `)

    const fn = exports.default as Function
    expect(fn.name).not.toBe('__default')
  })
})
