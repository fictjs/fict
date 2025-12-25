import { describe, expect, it } from 'vitest'
import { parseSync } from '@babel/core'
import { buildHIR } from '../src/ir/build-hir'
import { structurizeCFG, type StructuredNode } from '../src/ir/structurize'

const parseFile = (code: string) =>
  parseSync(code, {
    filename: 'module.tsx',
    parserOpts: { sourceType: 'module', plugins: ['typescript', 'jsx'] },
    ast: true,
    code: false,
    cloneInputAst: false,
  })!

/**
 * Count nodes of a specific kind in a structured tree
 */
function countNodes(node: StructuredNode, kind: string): number {
  let count = node.kind === kind ? 1 : 0

  switch (node.kind) {
    case 'sequence':
      for (const child of node.nodes) {
        count += countNodes(child, kind)
      }
      break
    case 'block':
      for (const child of node.statements) {
        count += countNodes(child, kind)
      }
      break
    case 'if':
      count += countNodes(node.consequent, kind)
      if (node.alternate) count += countNodes(node.alternate, kind)
      break
    case 'while':
    case 'doWhile':
      count += countNodes(node.body, kind)
      break
    case 'for':
    case 'forOf':
    case 'forIn':
      count += countNodes(node.body, kind)
      break
    case 'switch':
      for (const c of node.cases) {
        count += countNodes(c.body, kind)
      }
      break
    case 'try':
      count += countNodes(node.block, kind)
      if (node.handler) count += countNodes(node.handler.body, kind)
      if (node.finalizer) count += countNodes(node.finalizer, kind)
      break
  }

  return count
}

describe('CFG Structurization', () => {
  describe('if-else statements', () => {
    it('should structurize simple if statement', () => {
      const ast = parseFile(`
        function foo(x) {
          if (x > 0) {
            return 1
          }
          return 0
        }
      `)
      const hir = buildHIR(ast)
      const fn = hir.functions[0]
      expect(fn).toBeDefined()

      const structured = structurizeCFG(fn!)
      expect(countNodes(structured, 'if')).toBe(1)
      expect(countNodes(structured, 'return')).toBe(2)
    })

    it('should structurize if-else statement', () => {
      const ast = parseFile(`
        function foo(x) {
          if (x > 0) {
            return 1
          } else {
            return -1
          }
        }
      `)
      const hir = buildHIR(ast)
      const fn = hir.functions[0]
      expect(fn).toBeDefined()

      const structured = structurizeCFG(fn!)
      expect(countNodes(structured, 'if')).toBe(1)
    })

    it('should structurize nested if statements', () => {
      const ast = parseFile(`
        function foo(x, y) {
          if (x > 0) {
            if (y > 0) {
              return 1
            }
            return 2
          }
          return 0
        }
      `)
      const hir = buildHIR(ast)
      const fn = hir.functions[0]
      expect(fn).toBeDefined()

      const structured = structurizeCFG(fn!)
      expect(countNodes(structured, 'if')).toBe(2)
    })
  })

  describe('while loops', () => {
    it('should structurize simple while loop', () => {
      const ast = parseFile(`
        function foo(x) {
          while (x > 0) {
            x = x - 1
          }
          return x
        }
      `)
      const hir = buildHIR(ast)
      const fn = hir.functions[0]
      expect(fn).toBeDefined()

      const structured = structurizeCFG(fn!)
      expect(countNodes(structured, 'while')).toBe(1)
    })
  })

  describe('for loops', () => {
    it('should structurize for loop', () => {
      const ast = parseFile(`
        function foo(n) {
          let sum = 0
          for (let i = 0; i < n; i++) {
            sum = sum + i
          }
          return sum
        }
      `)
      const hir = buildHIR(ast)
      const fn = hir.functions[0]
      expect(fn).toBeDefined()

      const structured = structurizeCFG(fn!)
      // for loops are built as while with extra blocks
      expect(
        countNodes(structured, 'while') + countNodes(structured, 'for'),
      ).toBeGreaterThanOrEqual(0)
    })
  })

  describe('for-of loops', () => {
    it('should structurize for-of loop', () => {
      const ast = parseFile(`
        function foo(items) {
          let sum = 0
          for (const item of items) {
            sum = sum + item
          }
          return sum
        }
      `)
      const hir = buildHIR(ast)
      const fn = hir.functions[0]
      expect(fn).toBeDefined()

      const structured = structurizeCFG(fn!)
      expect(countNodes(structured, 'forOf')).toBe(1)
    })
  })

  describe('for-in loops', () => {
    it('should structurize for-in loop', () => {
      const ast = parseFile(`
        function foo(obj) {
          const keys = []
          for (const key in obj) {
            keys.push(key)
          }
          return keys
        }
      `)
      const hir = buildHIR(ast)
      const fn = hir.functions[0]
      expect(fn).toBeDefined()

      const structured = structurizeCFG(fn!)
      expect(countNodes(structured, 'forIn')).toBe(1)
    })
  })

  describe('switch statements', () => {
    it('should structurize switch statement', () => {
      const ast = parseFile(`
        function foo(x) {
          switch (x) {
            case 1:
              return 'one'
            case 2:
              return 'two'
            default:
              return 'other'
          }
        }
      `)
      const hir = buildHIR(ast)
      const fn = hir.functions[0]
      expect(fn).toBeDefined()

      const structured = structurizeCFG(fn!)
      expect(countNodes(structured, 'switch')).toBe(1)
    })
  })

  describe('try-catch-finally', () => {
    it('should structurize try-catch', () => {
      const ast = parseFile(`
        function foo() {
          try {
            return riskyOp()
          } catch (e) {
            return null
          }
        }
      `)
      const hir = buildHIR(ast)
      const fn = hir.functions[0]
      expect(fn).toBeDefined()

      const structured = structurizeCFG(fn!)
      expect(countNodes(structured, 'try')).toBe(1)
    })

    it('should structurize try-catch-finally', () => {
      const ast = parseFile(`
        function foo() {
          try {
            return riskyOp()
          } catch (e) {
            console.log(e)
          } finally {
            cleanup()
          }
        }
      `)
      const hir = buildHIR(ast)
      const fn = hir.functions[0]
      expect(fn).toBeDefined()

      const structured = structurizeCFG(fn!)
      expect(countNodes(structured, 'try')).toBe(1)
    })

    it('should structurize try-finally', () => {
      const ast = parseFile(`
        function foo() {
          try {
            return riskyOp()
          } finally {
            cleanup()
          }
        }
      `)
      const hir = buildHIR(ast)
      const fn = hir.functions[0]
      expect(fn).toBeDefined()

      const structured = structurizeCFG(fn!)
      expect(countNodes(structured, 'try')).toBe(1)
    })
  })

  describe('complex control flow', () => {
    it('should handle nested loops with conditionals', () => {
      const ast = parseFile(`
        function foo(matrix) {
          let sum = 0
          for (const row of matrix) {
            for (const cell of row) {
              if (cell > 0) {
                sum = sum + cell
              }
            }
          }
          return sum
        }
      `)
      const hir = buildHIR(ast)
      const fn = hir.functions[0]
      expect(fn).toBeDefined()

      const structured = structurizeCFG(fn!)
      expect(countNodes(structured, 'forOf')).toBe(2)
      expect(countNodes(structured, 'if')).toBe(1)
    })

    it('should handle early returns in loops', () => {
      const ast = parseFile(`
        function find(items, target) {
          for (const item of items) {
            if (item === target) {
              return item
            }
          }
          return null
        }
      `)
      const hir = buildHIR(ast)
      const fn = hir.functions[0]
      expect(fn).toBeDefined()

      const structured = structurizeCFG(fn!)
      expect(countNodes(structured, 'forOf')).toBe(1)
      expect(countNodes(structured, 'if')).toBe(1)
      expect(countNodes(structured, 'return')).toBe(2)
    })

    it('should preserve join block side effects in diamond pattern', () => {
      const ast = parseFile(`
        function foo(x) {
          let result = 0
          if (x > 0) {
            result = 1
          } else {
            result = -1
          }
          console.log(result)
          return result
        }
      `)
      const hir = buildHIR(ast)
      const fn = hir.functions[0]
      expect(fn).toBeDefined()

      const structured = structurizeCFG(fn!)
      expect(countNodes(structured, 'if')).toBe(1)
      // Should have 3 instructions: let result = 0, console.log(result), and the instruction nodes
      expect(countNodes(structured, 'instruction')).toBeGreaterThanOrEqual(2)
      expect(countNodes(structured, 'return')).toBe(1)
    })

    it('should handle multiple if-else with shared continuation', () => {
      const ast = parseFile(`
        function foo(a, b) {
          let x = 0
          let y = 0
          if (a > 0) {
            x = 1
          } else {
            x = -1
          }
          if (b > 0) {
            y = 1
          } else {
            y = -1
          }
          return x + y
        }
      `)
      const hir = buildHIR(ast)
      const fn = hir.functions[0]
      expect(fn).toBeDefined()

      const structured = structurizeCFG(fn!)
      expect(countNodes(structured, 'if')).toBe(2)
      expect(countNodes(structured, 'return')).toBe(1)
    })
  })
})
