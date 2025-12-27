import { describe, expect, it } from 'vitest'
import { parseSync } from '@babel/core'
import { buildHIR } from '../src/ir/build-hir'
import { printHIR } from '../src/ir/printer'

const parseFile = (code: string) =>
  parseSync(code, {
    filename: 'module.tsx',
    parserOpts: { sourceType: 'module', plugins: ['typescript', 'jsx'] },
    ast: true,
    code: false,
    cloneInputAst: false,
  })!

describe('buildHIR', () => {
  it('builds simple functions into blocks with branch', () => {
    const ast = parseFile(`
      function Foo(x) {
        let y = x + 1
        if (y > 1) {
          return y
        }
        return 0
      }
    `)
    const hir = buildHIR(ast)
    const printed = printHIR(hir)
    expect(printed).not.toContain('<hir empty>')
    expect(printed).toContain('block 0')
    expect(printed.toLowerCase()).toContain('branch')
    expect(printed.toLowerCase()).toContain('return')
  })

  it('builds while loops with branch and back-edge', () => {
    const ast = parseFile(`
      function Loop(n) {
        let i = 0
        while (i < n) {
          i = i + 1
        }
        return i
      }
    `)
    const hir = buildHIR(ast)
    const printed = printHIR(hir)
    expect(printed.toLowerCase()).toContain('branch')
    expect(printed.toLowerCase()).toContain('jump')
  })

  it('builds for loops with init/update and back-edge', () => {
    const ast = parseFile(`
      function Sum(n) {
        let total = 0
        for (let i = 0; i < n; i = i + 1) {
          total = total + i
        }
        return total
      }
    `)
    const hir = buildHIR(ast)
    const printed = printHIR(hir)
    expect(printed.toLowerCase()).toContain('jump')
    expect(printed.toLowerCase()).toContain('branch')
  })
})

describe('buildHIR - complex control flow', () => {
  it('handles nested if/else statements', () => {
    const ast = parseFile(`
      function NestedIf(x) {
        if (x > 0) {
          if (x > 10) {
            return 'large'
          } else {
            return 'medium'
          }
        } else {
          return 'negative'
        }
      }
    `)
    const hir = buildHIR(ast)
    const printed = printHIR(hir)
    expect(hir.functions[0].blocks.length).toBeGreaterThanOrEqual(4)
    expect(printed.toLowerCase()).toContain('branch')
    expect(printed).toContain('return')
  })

  it('handles if-else-if chains', () => {
    const ast = parseFile(`
      function Grade(score) {
        if (score >= 90) {
          return 'A'
        } else if (score >= 80) {
          return 'B'
        } else if (score >= 70) {
          return 'C'
        } else {
          return 'F'
        }
      }
    `)
    const hir = buildHIR(ast)
    expect(hir.functions[0].blocks.length).toBeGreaterThanOrEqual(5)
  })

  it('handles switch statements', () => {
    const ast = parseFile(`
      function DayName(day) {
        switch (day) {
          case 1:
            return 'Monday'
          case 2:
            return 'Tuesday'
          default:
            return 'Unknown'
        }
      }
    `)
    const hir = buildHIR(ast)
    const printed = printHIR(hir)
    expect(printed.toLowerCase()).toContain('switch')
    expect(hir.functions[0].blocks.length).toBeGreaterThanOrEqual(2)
  })

  it('handles do-while loops', () => {
    const ast = parseFile(`
      function DoWhile(n) {
        let i = 0
        do {
          i = i + 1
        } while (i < n)
        return i
      }
    `)
    const hir = buildHIR(ast)
    const printed = printHIR(hir)
    expect(printed.toLowerCase()).toContain('branch')
    expect(printed.toLowerCase()).toContain('jump')
  })

  it('handles try-catch blocks', () => {
    const ast = parseFile(`
      function TryCatch(x) {
        try {
          return x.foo
        } catch (e) {
          return null
        }
      }
    `)
    const hir = buildHIR(ast)
    expect(hir.functions[0]).toBeDefined()
    // Try-catch is simplified in current implementation
    const printed = printHIR(hir)
    expect(printed).toContain('function TryCatch')
  })

  it('handles nested loops', () => {
    const ast = parseFile(`
      function NestedLoop(n, m) {
        let sum = 0
        for (let i = 0; i < n; i = i + 1) {
          for (let j = 0; j < m; j = j + 1) {
            sum = sum + i * j
          }
        }
        return sum
      }
    `)
    const hir = buildHIR(ast)
    // Nested loops should create multiple blocks
    expect(hir.functions[0].blocks.length).toBeGreaterThanOrEqual(5)
    const printed = printHIR(hir)
    expect(printed.toLowerCase()).toContain('jump')
    expect(printed.toLowerCase()).toContain('branch')
  })

  it('handles if inside loop', () => {
    const ast = parseFile(`
      function LoopWithIf(n) {
        let evens = 0
        for (let i = 0; i < n; i = i + 1) {
          if (i % 2 === 0) {
            evens = evens + 1
          }
        }
        return evens
      }
    `)
    const hir = buildHIR(ast)
    expect(hir.functions[0].blocks.length).toBeGreaterThanOrEqual(4)
    const printed = printHIR(hir)
    expect(printed.toLowerCase()).toContain('branch')
  })
})

// ============================================================================
// P1 Test Fixtures: Advanced Patterns
// ============================================================================

describe('buildHIR - Advanced Patterns', () => {
  it('handles deep optional chain access', () => {
    const ast = parseFile(`
      function DeepOptional(props) {
        const name = props?.user?.profile?.name ?? 'anonymous'
        return name
      }
    `)
    const hir = buildHIR(ast)
    expect(hir.functions[0]).toBeDefined()
    const printed = printHIR(hir)
    expect(printed).toContain('name')
  })

  it('handles nested destructuring with spread', () => {
    const ast = parseFile(`
      function DestructureSpread(data) {
        const { user: { name, ...userRest }, items, ...rest } = data
        return { name, userRest, items, rest }
      }
    `)
    const hir = buildHIR(ast)
    expect(hir.functions[0]).toBeDefined()
  })

  it('handles array destructuring with defaults', () => {
    const ast = parseFile(`
      function ArrayDestructure(arr) {
        const [first = 0, second = 1, ...rest] = arr
        return first + second + rest.length
      }
    `)
    const hir = buildHIR(ast)
    expect(hir.functions[0]).toBeDefined()
  })

  it('handles object pattern variable declarations', () => {
    const ast = parseFile(`
      function Foo() {
        const { count, double } = useCounter()
        return count + double
      }
    `)
    const hir = buildHIR(ast)
    const fn = hir.functions[0]
    expect(fn.blocks.length).toBeGreaterThan(0)
    const assigns = fn.blocks.flatMap(b => b.instructions).filter(i => i.kind === 'Assign')
    const targets = assigns.map(a => (a as any).target.name)
    expect(targets.some(t => t.startsWith('__destruct_'))).toBe(true)
    expect(targets).toContain('count')
    expect(targets).toContain('double')
  })

  it('handles complex conditional with loops', () => {
    const ast = parseFile(`
      function ComplexControl(items, filter) {
        let result = []
        if (filter.enabled) {
          for (let i = 0; i < items.length; i++) {
            if (items[i].active) {
              result.push(items[i])
            }
          }
        } else {
          result = items.slice()
        }
        return result
      }
    `)
    const hir = buildHIR(ast)
    expect(hir.functions[0].blocks.length).toBeGreaterThanOrEqual(4)
  })

  it('handles nested ternary expressions', () => {
    const ast = parseFile(`
      function NestedTernary(a, b, c) {
        const result = a > 0
          ? b > 0
            ? 'both positive'
            : 'a positive only'
          : c > 0
            ? 'c positive only'
            : 'none positive'
        return result
      }
    `)
    const hir = buildHIR(ast)
    expect(hir.functions[0]).toBeDefined()
  })

  it('handles computed property access in loops', () => {
    const ast = parseFile(`
      function ComputedLoop(obj, keys) {
        let sum = 0
        for (let i = 0; i < keys.length; i++) {
          sum = sum + obj[keys[i]]
        }
        return sum
      }
    `)
    const hir = buildHIR(ast)
    expect(hir.functions[0].blocks.length).toBeGreaterThanOrEqual(3)
  })

  it('handles JSX with conditional children', () => {
    const ast = parseFile(`
      function ConditionalJSX(props) {
        return (
          <div>
            {props.show ? <span>{props.text}</span> : null}
            {props.items?.map(item => <li key={item.id}>{item.name}</li>)}
          </div>
        )
      }
    `)
    const hir = buildHIR(ast)
    expect(hir.functions[0]).toBeDefined()
    const printed = printHIR(hir)
    expect(printed.toLowerCase()).toContain('jsx')
  })

  it('handles callback with reactive closure', () => {
    const ast = parseFile(`
      function ReactiveCallback(items, onClick) {
        return items.map((item, i) => (
          <button onClick={() => onClick(item, i)}>
            {item.label}
          </button>
        ))
      }
    `)
    const hir = buildHIR(ast)
    expect(hir.functions[0]).toBeDefined()
  })
})

// ============================================================================
// Break/Continue Statement Tests
// ============================================================================

describe('buildHIR - break statements', () => {
  it('handles break in for-of loop', () => {
    const ast = parseFile(`
      function BreakForOf(items, target) {
        let found = null
        for (const item of items) {
          if (item.id === target) {
            found = item
            break
          }
        }
        return found
      }
    `)
    const hir = buildHIR(ast)
    const printed = printHIR(hir)
    expect(printed.toLowerCase()).toContain('break')
  })

  it('handles break in for-in loop', () => {
    const ast = parseFile(`
      function BreakForIn(obj, targetKey) {
        let foundValue = null
        for (const key in obj) {
          if (key === targetKey) {
            foundValue = obj[key]
            break
          }
        }
        return foundValue
      }
    `)
    const hir = buildHIR(ast)
    const printed = printHIR(hir)
    expect(printed.toLowerCase()).toContain('break')
  })

  it('handles break in nested for-of loops (inner loop only)', () => {
    const ast = parseFile(`
      function BreakNested(matrix) {
        let count = 0
        for (const row of matrix) {
          for (const cell of row) {
            if (cell < 0) {
              break
            }
            count = count + 1
          }
        }
        return count
      }
    `)
    const hir = buildHIR(ast)
    const printed = printHIR(hir)
    expect(printed.toLowerCase()).toContain('break')
    expect(hir.functions[0].blocks.length).toBeGreaterThanOrEqual(4)
  })
})

describe('buildHIR - continue statements', () => {
  it('handles continue in for-of loop', () => {
    const ast = parseFile(`
      function ContinueForOf(items) {
        const result = []
        for (const item of items) {
          if (!item.active) {
            continue
          }
          result.push(item)
        }
        return result
      }
    `)
    const hir = buildHIR(ast)
    const printed = printHIR(hir)
    expect(printed.toLowerCase()).toContain('continue')
  })

  it('handles continue in for-in loop', () => {
    const ast = parseFile(`
      function ContinueForIn(obj) {
        const result = {}
        for (const key in obj) {
          if (key.startsWith('_')) {
            continue
          }
          result[key] = obj[key]
        }
        return result
      }
    `)
    const hir = buildHIR(ast)
    const printed = printHIR(hir)
    expect(printed.toLowerCase()).toContain('continue')
  })

  it('handles multiple continue statements', () => {
    const ast = parseFile(`
      function MultiContinue(items) {
        const result = []
        for (const item of items) {
          if (item === null) {
            continue
          }
          if (item.skip) {
            continue
          }
          result.push(item)
        }
        return result
      }
    `)
    const hir = buildHIR(ast)
    const printed = printHIR(hir)
    expect((printed.toLowerCase().match(/continue/g) || []).length).toBeGreaterThanOrEqual(2)
  })
})

describe('buildHIR - labeled statements', () => {
  it('handles labeled break in nested for-of loops', () => {
    const ast = parseFile(`
      function LabeledBreak(matrix, target) {
        let found = false
        outer: for (const row of matrix) {
          for (const cell of row) {
            if (cell === target) {
              found = true
              break outer
            }
          }
        }
        return found
      }
    `)
    const hir = buildHIR(ast)
    expect(hir.functions[0]).toBeDefined()
    const printed = printHIR(hir)
    expect(printed.toLowerCase()).toContain('break')
  })

  it('handles labeled continue in nested for-of loops', () => {
    const ast = parseFile(`
      function LabeledContinue(matrix) {
        let sum = 0
        outer: for (const row of matrix) {
          for (const cell of row) {
            if (cell < 0) {
              continue outer
            }
            sum = sum + cell
          }
        }
        return sum
      }
    `)
    const hir = buildHIR(ast)
    expect(hir.functions[0]).toBeDefined()
    const printed = printHIR(hir)
    expect(printed.toLowerCase()).toContain('continue')
  })

  it('handles labeled block with break', () => {
    const ast = parseFile(`
      function LabeledBlock(items) {
        let result = null
        search: {
          for (const item of items) {
            if (item.match) {
              result = item
              break search
            }
          }
          result = { fallback: true }
        }
        return result
      }
    `)
    const hir = buildHIR(ast)
    expect(hir.functions[0]).toBeDefined()
  })

  it('handles multiple nested labeled loops', () => {
    const ast = parseFile(`
      function MultiLabel(cube) {
        let count = 0
        outer: for (const plane of cube) {
          middle: for (const row of plane) {
            for (const cell of row) {
              if (cell === 0) {
                continue middle
              }
              if (cell < 0) {
                break outer
              }
              count = count + 1
            }
          }
        }
        return count
      }
    `)
    const hir = buildHIR(ast)
    expect(hir.functions[0]).toBeDefined()
  })
})

describe('buildHIR - throw statements', () => {
  it('handles throw statement', () => {
    const ast = parseFile(`
      function ThrowError(x) {
        if (x < 0) {
          throw new Error('negative value')
        }
        return x
      }
    `)
    const hir = buildHIR(ast)
    const printed = printHIR(hir)
    expect(printed.toLowerCase()).toContain('throw')
  })

  it('handles throw in try-catch', () => {
    const ast = parseFile(`
      function ThrowInTry(x) {
        try {
          if (x === null) {
            throw new Error('null value')
          }
          return x.value
        } catch (e) {
          return 0
        }
      }
    `)
    const hir = buildHIR(ast)
    expect(hir.functions[0]).toBeDefined()
    const printed = printHIR(hir)
    expect(printed.toLowerCase()).toContain('throw')
  })

  it('handles rethrow in catch', () => {
    const ast = parseFile(`
      function Rethrow(fn) {
        try {
          return fn()
        } catch (e) {
          console.error(e)
          throw e
        }
      }
    `)
    const hir = buildHIR(ast)
    expect(hir.functions[0]).toBeDefined()
  })
})

describe('buildHIR - try-finally patterns', () => {
  it('handles try-finally without catch', () => {
    const ast = parseFile(`
      function TryFinally(resource) {
        try {
          return resource.read()
        } finally {
          resource.close()
        }
      }
    `)
    const hir = buildHIR(ast)
    expect(hir.functions[0]).toBeDefined()
    const printed = printHIR(hir)
    expect(printed).toContain('TryFinally')
  })

  it('handles return in try with finally', () => {
    const ast = parseFile(`
      function ReturnInTry(x) {
        let result = 0
        try {
          if (x > 0) {
            return x
          }
          result = x * -1
        } finally {
          console.log('cleanup')
        }
        return result
      }
    `)
    const hir = buildHIR(ast)
    expect(hir.functions[0]).toBeDefined()
  })

  it('handles throw in try with finally', () => {
    const ast = parseFile(`
      function ThrowInTryWithFinally(x) {
        try {
          if (x === null) {
            throw new Error('null')
          }
          return x
        } finally {
          console.log('always runs')
        }
      }
    `)
    const hir = buildHIR(ast)
    expect(hir.functions[0]).toBeDefined()
  })

  it('handles nested try-finally', () => {
    const ast = parseFile(`
      function NestedTryFinally(a, b) {
        try {
          try {
            return a.read()
          } finally {
            a.close()
          }
        } finally {
          b.cleanup()
        }
      }
    `)
    const hir = buildHIR(ast)
    expect(hir.functions[0]).toBeDefined()
  })
})

describe('buildHIR - switch fall-through', () => {
  it('handles switch with fall-through cases', () => {
    const ast = parseFile(`
      function SwitchFallthrough(x) {
        let result = ''
        switch (x) {
          case 1:
          case 2:
          case 3:
            result = 'small'
            break
          case 4:
          case 5:
            result = 'medium'
            break
          default:
            result = 'large'
        }
        return result
      }
    `)
    const hir = buildHIR(ast)
    expect(hir.functions[0]).toBeDefined()
    const printed = printHIR(hir)
    expect(printed.toLowerCase()).toContain('switch')
  })

  it('handles switch without default', () => {
    const ast = parseFile(`
      function SwitchNoDefault(x) {
        let result = 'unknown'
        switch (x) {
          case 'a':
            result = 'alpha'
            break
          case 'b':
            result = 'beta'
            break
        }
        return result
      }
    `)
    const hir = buildHIR(ast)
    expect(hir.functions[0]).toBeDefined()
  })

  it('handles switch with return in cases', () => {
    const ast = parseFile(`
      function SwitchReturn(x) {
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
    expect(hir.functions[0]).toBeDefined()
    const printed = printHIR(hir)
    expect(printed.toLowerCase()).toContain('return')
  })

  it('handles switch with mixed return and break', () => {
    const ast = parseFile(`
      function SwitchMixed(x, y) {
        let result = 0
        switch (x) {
          case 1:
            if (y > 0) {
              return y
            }
            result = 1
            break
          case 2:
            result = 2
            break
          default:
            return -1
        }
        return result
      }
    `)
    const hir = buildHIR(ast)
    expect(hir.functions[0]).toBeDefined()
  })
})
