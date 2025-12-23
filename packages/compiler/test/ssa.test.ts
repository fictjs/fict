import { describe, expect, it } from 'vitest'
import { parseSync } from '@babel/core'
import { buildHIR } from '../src/ir/build-hir'
import { enterSSA } from '../src/ir/ssa'
import { printHIR } from '../src/ir/printer'

const parseFile = (code: string) =>
  parseSync(code, {
    filename: 'module.tsx',
    parserOpts: { sourceType: 'module', plugins: ['typescript', 'jsx'] },
    ast: true,
    code: false,
    cloneInputAst: false,
  })!

describe('enterSSA', () => {
  it('renames assigns with versions', () => {
    const ast = parseFile(`
      function Foo() {
        let x = 1
        x = x + 1
        return x
      }
    `)
    const hir = buildHIR(ast)
    const ssa = enterSSA(hir)
    const printed = printHIR(ssa)
    expect(printed).toContain('x_1')
    expect(printed).toContain('x_2')
  })

  it('creates divergent versions across predecessors (phi pending full precision)', () => {
    const ast = parseFile(`
      function Foo(c) {
        let x = 0
        if (c) {
          x = 1
        }
        return x
      }
    `)
    const hir = buildHIR(ast)
    const ssa = enterSSA(hir)
    const printed = printHIR(ssa)
    expect(printed).toMatch(/x_1/)
    expect(printed).toMatch(/x_2/)
  })
})
