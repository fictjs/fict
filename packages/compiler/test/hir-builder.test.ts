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
