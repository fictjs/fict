import generate from '@babel/generator'
import { parseSync } from '@babel/core'
import * as t from '@babel/types'
import { describe, expect, it } from 'vitest'

import { buildHIR } from '../src/ir/build-hir'
import { lowerHIRWithRegions } from '../src/ir/codegen'

const parseFile = (code: string) =>
  parseSync(code, {
    filename: 'module.tsx',
    parserOpts: {
      sourceType: 'module',
      plugins: ['typescript', 'jsx', 'decorators'],
    },
    ast: true,
    code: false,
    cloneInputAst: false,
  })!

const compile = (source: string): string => {
  const hir = buildHIR(parseFile(source))
  const file = lowerHIRWithRegions(hir, t)
  return generate(file).code
}

describe('class decorator preservation', () => {
  it('preserves non-exported class declaration decorators', () => {
    const code = compile(`
      function dec(value) {
        value.marked = true
      }

      @dec
      class C {}

      export { C }
    `)

    expect(code).toContain('@dec')
    expect(code).toMatch(/let C = @dec\s*class C/)
    expect(code).toContain('export { C };')
  })

  it('keeps exported class declaration decorators on the pass-through path', () => {
    const code = compile(`
      function dec(value) {
        value.marked = true
      }

      @dec
      export class C {}
    `)

    expect(code).toMatch(/(?:@dec\s*export|export\s*@dec)\s*class C/)
  })

  it('preserves class expression and member decorators', () => {
    const code = compile(`
      function dec(value) {
        value.marked = true
      }
      function member(value) {
        value.marked = true
      }

      const C = @dec class {
        @member
        m() {}
      }

      export { C }
    `)

    expect(code).toMatch(/const C = @dec\s*class/)
    expect(code).toMatch(/@member\s*m\(\)/)
  })
})
