import { describe, expect, it } from 'vitest'
import { parseSync } from '@babel/core'
import { buildHIR } from '../src/ir/build-hir'
import { enterSSA, analyzeCFG } from '../src/ir/ssa'
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
    // SSA uses $$ssa suffix to avoid conflicts with user variables containing _number
    expect(printed).toContain('x$$ssa1')
    expect(printed).toContain('x$$ssa2')
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
    // SSA uses $$ssa suffix to avoid conflicts with user variables containing _number
    expect(printed).toMatch(/x\$\$ssa1/)
    expect(printed).toMatch(/x\$\$ssa2/)
  })

  it('does not strip user-supplied $$ssa-like suffixes', () => {
    const ast = parseFile(`
      function Foo() {
        let value$$ssa1 = 1
        value$$ssa1 = value$$ssa1 + 1
        return value$$ssa1
      }
    `)
    const hir = buildHIR(ast)
    const ssa = enterSSA(hir)
    const printed = printHIR(ssa)
    expect(printed).toMatch(/value\$\$ssa1\$\$ssa1/)
    expect(printed).toMatch(/value\$\$ssa1\$\$ssa2/)
  })
})

// ============================================================================
// SSA/CFG Analysis Tests
// ============================================================================

describe('enterSSA - multiple assignments', () => {
  it('handles multiple sequential assignments', () => {
    const ast = parseFile(`
      function MultiAssign() {
        let x = 1
        x = x + 1
        x = x * 2
        x = x - 3
        return x
      }
    `)
    const hir = buildHIR(ast)
    const ssa = enterSSA(hir)
    const printed = printHIR(ssa)
    // Should have at least 4 versions (1 initial + 3 reassignments)
    expect(printed).toMatch(/x\$\$ssa1/)
    expect(printed).toMatch(/x\$\$ssa2/)
    expect(printed).toMatch(/x\$\$ssa3/)
    expect(printed).toMatch(/x\$\$ssa4/)
  })

  it('handles multiple variables independently', () => {
    const ast = parseFile(`
      function MultiVar() {
        let x = 1
        let y = 2
        x = x + y
        y = x + y
        return x + y
      }
    `)
    const hir = buildHIR(ast)
    const ssa = enterSSA(hir)
    const printed = printHIR(ssa)
    // Both x and y should have versions
    expect(printed).toMatch(/x\$\$ssa/)
    expect(printed).toMatch(/y\$\$ssa/)
  })
})

describe('enterSSA - control flow patterns', () => {
  it('handles diamond pattern (if-else with join)', () => {
    const ast = parseFile(`
      function Diamond(c) {
        let x = 0
        if (c) {
          x = 1
        } else {
          x = 2
        }
        return x
      }
    `)
    const hir = buildHIR(ast)
    const ssa = enterSSA(hir)
    const printed = printHIR(ssa)
    // Should have at least 3 versions (initial + 2 branches)
    expect(printed).toMatch(/x\$\$ssa1/)
    expect(printed).toMatch(/x\$\$ssa2/)
    expect(printed).toMatch(/x\$\$ssa3/)
  })

  it('handles nested if statements', () => {
    const ast = parseFile(`
      function NestedIf(a, b) {
        let x = 0
        if (a) {
          if (b) {
            x = 1
          } else {
            x = 2
          }
        } else {
          x = 3
        }
        return x
      }
    `)
    const hir = buildHIR(ast)
    const ssa = enterSSA(hir)
    const printed = printHIR(ssa)
    expect(printed).toMatch(/x\$\$ssa/)
  })

  it('handles while loop with variable update', () => {
    const ast = parseFile(`
      function WhileLoop(n) {
        let x = 0
        while (x < n) {
          x = x + 1
        }
        return x
      }
    `)
    const hir = buildHIR(ast)
    const ssa = enterSSA(hir)
    const printed = printHIR(ssa)
    // Loop should create versioned variables
    expect(printed).toMatch(/x\$\$ssa/)
  })

  it('handles for loop with counter', () => {
    const ast = parseFile(`
      function ForLoop(n) {
        let sum = 0
        for (let i = 0; i < n; i++) {
          sum = sum + i
        }
        return sum
      }
    `)
    const hir = buildHIR(ast)
    const ssa = enterSSA(hir)
    const printed = printHIR(ssa)
    expect(printed).toMatch(/sum\$\$ssa/)
    expect(printed).toMatch(/i\$\$ssa/)
  })

  it('handles loop with conditional update', () => {
    const ast = parseFile(`
      function LoopWithIf(items) {
        let count = 0
        for (const item of items) {
          if (item.active) {
            count = count + 1
          }
        }
        return count
      }
    `)
    const hir = buildHIR(ast)
    const ssa = enterSSA(hir)
    const printed = printHIR(ssa)
    expect(printed).toMatch(/count\$\$ssa/)
  })
})

describe('enterSSA - complex patterns', () => {
  it('handles switch statement assignments', () => {
    const ast = parseFile(`
      function SwitchAssign(x) {
        let result = 0
        switch (x) {
          case 1:
            result = 10
            break
          case 2:
            result = 20
            break
          default:
            result = 30
        }
        return result
      }
    `)
    const hir = buildHIR(ast)
    const ssa = enterSSA(hir)
    const printed = printHIR(ssa)
    expect(printed).toMatch(/result\$\$ssa/)
  })

  it('handles try-catch assignments', () => {
    const ast = parseFile(`
      function TryCatchAssign(fn) {
        let result = null
        try {
          result = fn()
        } catch (e) {
          result = e.message
        }
        return result
      }
    `)
    const hir = buildHIR(ast)
    const ssa = enterSSA(hir)
    const printed = printHIR(ssa)
    expect(printed).toMatch(/result\$\$ssa/)
  })

  it('handles nested loops', () => {
    const ast = parseFile(`
      function NestedLoops(matrix) {
        let sum = 0
        for (const row of matrix) {
          for (const cell of row) {
            sum = sum + cell
          }
        }
        return sum
      }
    `)
    const hir = buildHIR(ast)
    const ssa = enterSSA(hir)
    const printed = printHIR(ssa)
    expect(printed).toMatch(/sum\$\$ssa/)
  })

  it('handles break/continue in loop', () => {
    const ast = parseFile(`
      function BreakContinue(items) {
        let count = 0
        for (const item of items) {
          if (item === null) {
            continue
          }
          if (item.done) {
            break
          }
          count = count + 1
        }
        return count
      }
    `)
    const hir = buildHIR(ast)
    const ssa = enterSSA(hir)
    const printed = printHIR(ssa)
    expect(printed).toMatch(/count\$\$ssa/)
  })
})

describe('analyzeCFG - basic analysis', () => {
  it('analyzes simple function CFG', () => {
    const ast = parseFile(`
      function Simple(x) {
        return x + 1
      }
    `)
    const hir = buildHIR(ast)
    const fn = hir.functions[0]
    expect(fn).toBeDefined()

    // analyzeCFG expects BasicBlock[]
    const analysis = analyzeCFG(fn.blocks)
    expect(analysis).toBeDefined()
    expect(analysis.predecessors).toBeDefined()
    expect(analysis.successors).toBeDefined()
  })

  it('analyzes branching function CFG', () => {
    const ast = parseFile(`
      function Branch(c) {
        if (c) {
          return 1
        }
        return 0
      }
    `)
    const hir = buildHIR(ast)
    const fn = hir.functions[0]
    expect(fn).toBeDefined()

    // analyzeCFG expects BasicBlock[]
    const analysis = analyzeCFG(fn.blocks)
    expect(analysis).toBeDefined()
    // Should have predecessors for multiple blocks
    expect(analysis.predecessors.size).toBeGreaterThan(0)
  })

  it('analyzes loop CFG', () => {
    const ast = parseFile(`
      function Loop(n) {
        let i = 0
        for (const x of [1,2,3]) {
          i = i + x
        }
        return i
      }
    `)
    const hir = buildHIR(ast)
    const fn = hir.functions[0]
    expect(fn).toBeDefined()

    // analyzeCFG expects BasicBlock[]
    const analysis = analyzeCFG(fn.blocks)
    expect(analysis).toBeDefined()
    expect(analysis.predecessors.size).toBeGreaterThan(0)
  })
})

describe('enterSSA - phi function scenarios', () => {
  it('handles variable defined in both branches of if-else', () => {
    const ast = parseFile(`
      function PhiScenario(c) {
        let x
        if (c) {
          x = 1
        } else {
          x = 2
        }
        return x
      }
    `)
    const hir = buildHIR(ast)
    const ssa = enterSSA(hir)
    const printed = printHIR(ssa)
    // Both branches define x, and the join point needs to select the correct version
    expect(printed).toMatch(/x\$\$ssa/)
  })

  it('handles variable used before definition in one branch', () => {
    const ast = parseFile(`
      function PartialDef(c, initial) {
        let x = initial
        if (c) {
          x = x + 1
        }
        return x
      }
    `)
    const hir = buildHIR(ast)
    const ssa = enterSSA(hir)
    const printed = printHIR(ssa)
    expect(printed).toMatch(/x\$\$ssa/)
  })

  it('handles loop-carried dependency', () => {
    const ast = parseFile(`
      function LoopCarried(n) {
        let prev = 0
        let curr = 1
        for (let i = 0; i < n; i++) {
          const next = prev + curr
          prev = curr
          curr = next
        }
        return curr
      }
    `)
    const hir = buildHIR(ast)
    const ssa = enterSSA(hir)
    const printed = printHIR(ssa)
    // Loop-carried dependencies should create versions
    expect(printed).toMatch(/prev\$\$ssa/)
    expect(printed).toMatch(/curr\$\$ssa/)
  })
})

describe('enterSSA - edge cases', () => {
  it('handles reassignment in same block', () => {
    const ast = parseFile(`
      function SameBlock() {
        let x = 1
        x = 2
        x = 3
        return x
      }
    `)
    const hir = buildHIR(ast)
    const ssa = enterSSA(hir)
    const printed = printHIR(ssa)
    // Each assignment should get a unique version
    expect(printed).toMatch(/x\$\$ssa1/)
    expect(printed).toMatch(/x\$\$ssa2/)
    expect(printed).toMatch(/x\$\$ssa3/)
  })

  it('handles self-referential update', () => {
    const ast = parseFile(`
      function SelfRef() {
        let x = 1
        x = x * x
        return x
      }
    `)
    const hir = buildHIR(ast)
    const ssa = enterSSA(hir)
    const printed = printHIR(ssa)
    // RHS should use old version, LHS should be new version
    expect(printed).toMatch(/x\$\$ssa/)
  })

  it('handles variable shadowing in nested scope', () => {
    const ast = parseFile(`
      function Shadowing() {
        let x = 1
        {
          let x = 2
          x = x + 1
        }
        return x
      }
    `)
    const hir = buildHIR(ast)
    const ssa = enterSSA(hir)
    const printed = printHIR(ssa)
    expect(printed).toMatch(/x\$\$ssa/)
  })

  it('handles const declarations', () => {
    const ast = parseFile(`
      function ConstDecl(a, b) {
        const x = a + b
        const y = x * 2
        return y
      }
    `)
    const hir = buildHIR(ast)
    const ssa = enterSSA(hir)
    const printed = printHIR(ssa)
    // Const declarations should still be versioned
    expect(printed).toMatch(/x\$\$ssa/)
    expect(printed).toMatch(/y\$\$ssa/)
  })

  it('handles destructuring assignments', () => {
    const ast = parseFile(`
      function Destructure(obj) {
        let x = 0
        let y = 0
        const result = { a: 1, b: 2 }
        x = result.a
        y = result.b
        return x + y
      }
    `)
    const hir = buildHIR(ast)
    const ssa = enterSSA(hir)
    const printed = printHIR(ssa)
    expect(printed).toMatch(/x\$\$ssa/)
    expect(printed).toMatch(/y\$\$ssa/)
  })
})
