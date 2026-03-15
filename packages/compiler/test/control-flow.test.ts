import { describe, it, expect } from 'vitest'
import { transform } from './test-utils'

/**
 * Helper to transform source code and return the result
 */
function runTransform(source: string): string {
  return transform(source)
}

function runTransformWithWarnings(source: string): { output: string; warnings: string[] } {
  const warnings: string[] = []
  const output = transform(source, {
    dev: true,
    onWarn(warning) {
      warnings.push(`${warning.code}:${warning.message}`)
    },
  })
  return { output, warnings }
}

describe('Fict Compiler - Control Flow', () => {
  describe('Conditional expressions', () => {
    it('handles conditional in JSX (&&)', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let show = $state(true)
          const el = <div>{show && <Modal />}</div>
          return el
        }
      `
      const output = runTransform(input)
      // Should wrap the conditional in an arrow function
      expect(output).toContain('() => show()')
    })

    it('handles ternary operator in JSX', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let condition = $state(true)
          const el = <div>{condition ? <A /> : <B />}</div>
          return el
        }
      `
      const output = runTransform(input)
      // Should wrap the ternary in an arrow function
      expect(output).toContain('() => condition()')
    })

    it('handles conditional assignment in component', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let count = $state(0)
          const status = count > 10 ? 'high' : 'low'
          return status
        }
      `
      const output = runTransform(input)
      expect(output).toContain('count() > 10')
    })
  })

  describe('List rendering', () => {
    it('handles array map in JSX with key (keyed list)', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let items = $state([1, 2, 3])
          const el = <ul>{items.map(item => <li key={item}>{item}</li>)}</ul>
          return el
        }
      `
      const output = runTransform(input)
      // Should use fine-grained list helpers
      expect(output).toContain('createKeyedList')
      // Should have getItems arrow function
      expect(output).toContain('() => items()')
      // Keyed list callback should have __key as third parameter for key constification
      expect(output).toContain('__key')
    })

    it('handles keyed list with object property as key', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let users = $state([{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }])
          const el = <ul>{users.map(user => <li key={user.id}>{user.name}</li>)}</ul>
          return el
        }
      `
      const output = runTransform(input)
      // Should use fine-grained list helpers
      expect(output).toContain('createKeyedList')
      // Should access user property with getter pattern
      expect(output).toContain('user()')
    })

    it('does not emit unresolved key identifiers for block-bodied map callbacks', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let users = $state([{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }])
          const el = (
            <ul>
              {users.map(user => {
                const id = user.id
                return <li key={id}>{user.name}</li>
              })}
            </ul>
          )
          return el
        }
      `
      const output = runTransform(input)
      expect(output).toContain('createKeyedList')
      expect(output).not.toMatch(/createKeyedList\([\s\S]*?=>\s*id\b/)
    })

    it('does not emit unresolved key member aliases for block-bodied map callbacks', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let users = $state([{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }])
          const el = (
            <ul>
              {users.map(user => {
                const meta = { id: user.id }
                return <li key={meta.id}>{user.name}</li>
              })}
            </ul>
          )
          return el
        }
      `
      const output = runTransform(input)
      expect(output).toContain('createKeyedList')
      expect(output).not.toMatch(/createKeyedList\([\s\S]*?=>\s*meta\.id\b/)
    })

    it('preserves reassigned key alias semantics in block-bodied map callbacks', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let users = $state([{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }])
          const el = (
            <ul>
              {users.map(user => {
                let id = user.id
                id = 42
                return <li key={id}>{user.name}</li>
              })}
            </ul>
          )
          return el
        }
      `
      const output = runTransform(input)
      expect(output).toContain('createKeyedList')
      expect(output).toMatch(/createKeyedList\([\s\S]*?=>\s*42\b/)
      expect(output).not.toMatch(/createKeyedList\([\s\S]*?=>\s*user\(\)\.id\b/)
    })

    it('does not emit unresolved local key helper callees in block-bodied map callbacks', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let users = $state([{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }])
          const el = (
            <ul>
              {users.map(user => {
                const makeKey = value => value.id
                return <li key={makeKey(user)}>{user.name}</li>
              })}
            </ul>
          )
          return el
        }
      `
      const output = runTransform(input)
      expect(output).toContain('createKeyedList')
      expect(output).not.toMatch(/createKeyedList\([\s\S]*?=>\s*makeKey\s*\(/)
    })

    it('does not emit unresolved key identifiers for control-flow-derived aliases in map callbacks', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let users = $state([{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }])
          const el = (
            <ul>
              {users.map(user => {
                let id
                if (user.id > 1) {
                  id = 42
                } else {
                  id = user.id
                }
                return <li key={id}>{user.name}</li>
              })}
            </ul>
          )
          return el
        }
      `
      const output = runTransform(input)
      expect(output).toContain('createKeyedList')
      expect(output).not.toMatch(/createKeyedList\([\s\S]*?=>\s*id\b/)
    })

    it('handles list without key via keyed list with index keys', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let items = $state([1, 2, 3])
          const el = <ul>{items.map(item => <li>{item}</li>)}</ul>
          return el
        }
      `
      const output = runTransform(input)
      expect(output).toContain('createKeyedList')
      expect(output).toContain('() => items()')
      // Index signal should be threaded through when requested
      expect(output).toContain('__index')
    })

    it('keeps stable key extraction for ternary callbacks when all branches are keyed', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let users = $state([{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }])
          return (
            <ul>
              {users.map(user =>
                user.id % 2 === 0
                  ? <li key={user.id}>{user.name}</li>
                  : <li key={user.id}>{user.name.toUpperCase()}</li>
              )}
            </ul>
          )
        }
      `

      const output = runTransform(input)
      expect(output).toContain('createKeyedList')
      expect(output).not.toMatch(/createKeyedList\([\s\S]*?=>\s*__index\b/)
      expect(output).toMatch(/createKeyedList\([\s\S]*?\.id\b/)
    })

    it('preserves keyed extraction when ternary branches use different key expressions', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let users = $state([
            { type: 'a', aId: 1, bId: 101, name: 'Alice' },
            { type: 'b', aId: 2, bId: 202, name: 'Bob' },
          ])
          return (
            <ul>
              {users.map(user =>
                user.type === 'a'
                  ? <li key={user.aId}>{user.name}</li>
                  : <li key={user.bId}>{user.name}</li>
              )}
            </ul>
          )
        }
      `

      const output = runTransform(input)
      expect(output).toContain('createKeyedList')
      expect(output).not.toMatch(/createKeyedList\([\s\S]*?=>\s*__index\b/)
      expect(output).toMatch(/createKeyedList\([\s\S]*?\?\s*user\.aId\s*:\s*user\.bId/)
    })

    it('uses returned sequence tail for key extraction', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let users = $state([{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }])
          return (
            <ul>
              {users.map(user => (
                <li>{user.name}</li>,
                <li key={user.id}>{user.name}</li>
              ))}
            </ul>
          )
        }
      `

      const output = runTransform(input)
      expect(output).toContain('createKeyedList')
      expect(output).not.toMatch(/createKeyedList\([\s\S]*?=>\s*__index\b/)
      expect(output).toMatch(/createKeyedList\([\s\S]*?\.id\b/)
    })

    it('handles array map with index', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let items = $state(['a', 'b', 'c'])
          const list = items.map((item, i) => \`\${i}: \${item}\`)
          return list
        }
      `
      const output = runTransform(input)
      expect(output).toContain('items().map')
    })

    it('handles nested derived values in map', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let multiplier = $state(2)
          let numbers = $state([1, 2, 3])
          const doubled = numbers.map(n => n * multiplier)
          return doubled
        }
      `
      const output = runTransform(input)
      // Both state variables should be transformed
      expect(output).toContain('multiplier()')
      expect(output).toContain('numbers()')
    })
  })

  describe('If statements with derived values', () => {
    it('handles derived values in if block', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let count = $state(0)
          let message
          if (count > 10) {
            message = 'High'
          } else {
            message = 'Low'
          }
          return message
        }
      `
      const output = runTransform(input)
      // count should be transformed in conditional
      expect(output).toContain('count() > 10')
      // message is treated as a derived binding inside control flow
      expect(output).toContain('__fictUseMemo')
    })

    it('handles const derived in if block', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let count = $state(0)
          if (count > 0) {
            const message = \`Count: \${count}\`
            return message
          }
          return null
        }
      `
      const output = runTransform(input)
      // const in if block referencing state should be memoized
      expect(output).toContain('count()')
    })
  })

  describe('Switch statements', () => {
    it('handles switch with state variable', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let status = $state('idle')
          let color
          switch (status) {
            case 'idle':
              color = 'gray'
              break
            case 'loading':
              color = 'blue'
              break
            default:
              color = 'black'
          }
          return color
        }
      `
      const output = runTransform(input)
      expect(output).toContain('status()')
    })

    it('converts switch-return branches into reactive conditionals', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let mode = $state('a')
          switch (mode) {
            case 'a':
              return <div>A: {mode}</div>
            case 'b':
              return <div>B: {mode}</div>
            default:
              return <div>D: {mode}</div>
          }
        }
      `
      const output = runTransform(input)
      expect(output).toContain('createConditional')
    })

    it('preserves break boundaries for switch with trailing return', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let mode = $state(0)
          let label = 'A'
          switch (mode) {
            case 0:
              label = 'A'
              break
            case 1:
              label = 'B'
              break
            default:
              label = 'D'
              break
          }
          return <div>{label}</div>
        }
      `
      const output = runTransform(input)
      expect(output).toContain('switch (mode())')
      expect(output).toContain('break;')
    })

    it('handles switch case blocks without dropping branch content', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let mode = $state('a')
          switch (mode) {
            case 'a': {
              return <div>A</div>
            }
            default:
              return <div>B</div>
          }
        }
      `
      const output = runTransform(input)
      expect(output).toContain('A')
      expect(output).toContain('B')
    })

    it('keeps switch case block return when followed by case-level break', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let mode = $state('a')
          switch (mode) {
            case 'a': {
              return <div>A</div>
            }
            break
            default:
              return <div>B</div>
          }
        }
      `
      const output = runTransform(input)
      expect(output).toContain('A')
      expect(output).toContain('B')
      expect(output).toContain('createConditional')
    })

    it('converts switch fallthrough labels into reactive conditionals', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let mode = $state('a')
          switch (mode) {
            case 'a':
            case 'b':
              return <div>AB</div>
            default:
              return <div>D</div>
          }
        }
      `
      const output = runTransform(input)
      expect(output).toContain('createConditional')
    })

    it('converts non-empty switch fallthrough branches into reactive conditionals', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let mode = $state('a')
          switch (mode) {
            case 'a':
              'fallthrough'
            case 'b':
              return <div>AB</div>
            default:
              return <div>D</div>
          }
        }
      `
      const output = runTransform(input)
      expect(output).toContain('createConditional')
    })

    it('supports complex switch discriminants in reactive lowering', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let mode = $state('a')
          switch (mode + '-v') {
            case 'a-v':
              return <div>A</div>
            default:
              return <div>D</div>
          }
        }
      `
      const output = runTransform(input)
      expect(output).toContain('createConditional')
      expect(output).toContain('createMemo')
    })

    it('memoizes switch discriminant reads to avoid duplicated side effects', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let mode = $state('a')
          function next() {
            console.log('next')
            return mode
          }
          switch (next()) {
            case 'a':
              return <div>A</div>
            default:
              return <div>B</div>
          }
        }
      `
      const output = runTransform(input)
      expect(output).toContain('createMemo')
      expect(output).toContain('createMemo(() => next())')
    })
  })

  describe('Try statements', () => {
    it('converts try-return branches into reactive conditionals', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let mode = $state('a')
          try {
            if (mode === 'a') {
              return <div>A: {mode}</div>
            }
            return <div>B: {mode}</div>
          } catch (e) {
            return <div>E: {String(e)}</div>
          }
        }
      `
      const output = runTransform(input)
      expect(output).toContain('try')
      expect(output).toContain('createConditional')
    })

    it('converts try-finally return branches into reactive conditionals', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let mode = $state('a')
          try {
            return <div>Base</div>
          } finally {
            if (mode === 'a') return <div>A</div>
            return <div>B</div>
          }
        }
      `
      const output = runTransform(input)
      expect(output).toContain('try')
      expect(output).toContain('createConditional')
    })
  })

  describe('Loops and derived values', () => {
    it('handles for loop with state read', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let max = $state(10)
          let sum = 0
          for (let i = 0; i < max; i++) {
            sum += i
          }
          return sum
        }
      `
      const output = runTransform(input)
      // max should be read with getter in condition
      expect(output).toContain('max()')
    })

    it('handles for-of loop with state array', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let items = $state([1, 2, 3])
          let sum = 0
          for (const item of items) {
            sum += item
          }
          return sum
        }
      `
      const output = runTransform(input)
      expect(output).toContain('items()')
    })

    it('throws error for $state declaration in for loop', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          for (let i = 0; i < 10; i++) {
            let count = $state(0)
          }
        }
      `
      expect(() => runTransform(input)).toThrow('cannot be declared inside loops')
    })

    it('preserves for-loop updates on continue inside nested functions', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let n = $state(3)
          const fn = () => {
            let total = 0
            for (let i = 0; i < n; i++) {
              if (i === 1) {
                continue
              }
              total += i
            }
            return total
          }
          return <button>{fn()}</button>
        }
      `
      const output = runTransform(input)

      const hasStructuredForLoop = /for\s*\(\s*(?:let i = 0\s*)?;\s*i < n\(\);\s*i\+\+\s*\)/.test(
        output,
      )
      const hasSafeContinueUpdate = /if\s*\(i === 1\)\s*\{\s*i\+\+;\s*continue;\s*\}/.test(output)

      expect(hasStructuredForLoop || hasSafeContinueUpdate).toBe(true)
      expect(output).not.toMatch(
        /while\s*\(i < n\(\)\)\s*\{[\s\S]*?if\s*\(i === 1\)\s*\{\s*continue;\s*\}/,
      )
    })
  })

  describe('Nested control flow', () => {
    it('handles nested conditionals', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let a = $state(1)
          let b = $state(2)
          const result = a > 0 ? (b > 0 ? 'both positive' : 'a positive') : 'a not positive'
          return result
        }
      `
      const output = runTransform(input)
      expect(output).toContain('a()')
      expect(output).toContain('b()')
    })

    it('handles conditional in map', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let items = $state([1, 2, 3, 4, 5])
          let threshold = $state(3)
          const filtered = items.map(x => x > threshold ? 'high' : 'low')
          return filtered
        }
      `
      const output = runTransform(input)
      expect(output).toContain('items()')
      expect(output).toContain('threshold()')
    })

    it('enables tracked branch fallback for nested reactive if side effects', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let count = $state(0)
          if (count >= 2) {
            if (count % 2 === 0) {
              console.log('high and even')
            } else {
              console.log('high and odd')
            }
            return <div>High: {count}</div>
          }
          return <div>Low: {count}</div>
        }
      `
      const output = runTransform(input)
      expect(output).toContain('createConditional')
      expect(output).toContain('trackBranchReads: true')
    })

    it('enables tracked branch fallback for reactive side-effect reads before return', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let show = $state(true)
          let count = $state(0)
          if (show) {
            console.log(count)
            return <div>{count}</div>
          }
          return <div>OFF</div>
        }
      `
      const output = runTransform(input)
      expect(output).toContain('createConditional')
      expect(output).toContain('trackBranchReads: true')
    })

    it('enables tracked branch fallback for immediate function invocation reads', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let show = $state(true)
          let count = $state(0)
          if (show) {
            (() => {
              console.log(count)
            })()
            return <div>{count}</div>
          }
          return <div>OFF</div>
        }
      `
      const output = runTransform(input)
      expect(output).toContain('createConditional')
      expect(output).toContain('trackBranchReads: true')
    })

    it('enables tracked branch fallback for reactive store member reads before return', () => {
      const input = `
        import { $state, $store } from 'fict'
        function Component() {
          let show = $state(true)
          const store = $store({ n: 0 })
          if (show) {
            console.log(store.n)
            return <div>{store.n}</div>
          }
          return <div>OFF</div>
        }
      `
      const output = runTransform(input)
      expect(output).toContain('createConditional')
      expect(output).toContain('trackBranchReads: true')
    })

    it('enables tracked branch fallback for reactive store destructuring before return', () => {
      const input = `
        import { $state, $store } from 'fict'
        function Component() {
          let show = $state(true)
          const store = $store({ n: 0 })
          if (show) {
            const { n } = store
            return <div>{n}</div>
          }
          return <div>OFF</div>
        }
      `
      const output = runTransform(input)
      expect(output).toContain('createConditional')
      expect(output).toContain('trackBranchReads: true')
    })

    it('enables tracked branch fallback for reactive props member reads before return', () => {
      const input = `
        import { $state } from 'fict'
        function Component(props) {
          let show = $state(true)
          if (show) {
            console.log(props.value)
            return <div>{props.value}</div>
          }
          return <div>OFF</div>
        }
      `
      const output = runTransform(input)
      expect(output).toContain('createConditional')
      expect(output).toContain('trackBranchReads: true')
    })

    it('keeps pure jsx return branches on fine-grained path', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let show = $state(true)
          let count = $state(0)
          if (show) {
            return <div>{count}</div>
          }
          return <div>OFF</div>
        }
      `
      const output = runTransform(input)
      expect(output).toContain('createConditional')
      expect(output).not.toContain('trackBranchReads: true')
    })
  })

  describe('Unsupported statement handling', () => {
    it('preserves class declarations in JSX-bearing components', () => {
      const input = `
        function Component() {
          class X {
            value() { return 1 }
          }
          return <div>{new X().value()}</div>
        }
      `
      const output = runTransform(input)
      expect(output).toContain('class X')
      expect(output).toContain('new X().value()')
    })

    it('handles labeled loops without dropping behavior', () => {
      const input = `
        function Component() {
          let total = 0
          outer: for (const row of [[1, 2], [3]]) {
            for (const cell of row) {
              if (cell === 2) continue outer
              total = total + cell
            }
          }
          return <div>{total}</div>
        }
      `
      const output = runTransform(input)
      expect(output).toContain('continue outer')
      expect(output).toContain('total')
    })

    it('emits FICT-R003 when reactive if-return lowering is skipped', () => {
      const input = `
        function Component({ mode }) {
          if (mode) {
            while (true) {
              break
            }
          }
          return <div>{mode}</div>
        }
      `
      const { warnings } = runTransformWithWarnings(input)
      expect(
        warnings.some(
          warning =>
            warning.includes('FICT-R003') &&
            warning.includes('Reactive if-return lowering was skipped'),
        ),
      ).toBe(true)
    })

    it('emits FICT-R006 when reactive state is read in control-flow conditions', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let count = $state(0)
          if (count > 10) {
            return <Big />
          }
          return <Small />
        }
      `
      const { warnings } = runTransformWithWarnings(input)
      expect(
        warnings.some(warning => warning.includes('FICT-R006') && warning.includes('count')),
      ).toBe(true)
    })

    it('does not emit FICT-R006 for expression-only branching in JSX', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let count = $state(0)
          return <div>{count > 10 ? <Big /> : <Small />}</div>
        }
      `
      const { warnings } = runTransformWithWarnings(input)
      expect(warnings.some(warning => warning.includes('FICT-R006'))).toBe(false)
    })
  })
})

describe('Fict Compiler - Complex Scenarios', () => {
  describe('Mixed reactive and non-reactive', () => {
    it('handles mix of reactive and static values', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let count = $state(0)
          const staticValue = 42
          const combined = count + staticValue
          return combined
        }
      `
      const output = runTransform(input)
      expect(output).toContain('count() + staticValue')
    })

    it('handles reactive in some branches, not others', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let useReactive = $state(true)
          let reactiveValue = $state(10)
          const result = useReactive ? reactiveValue : 5
          return result
        }
      `
      const output = runTransform(input)
      expect(output).toContain('useReactive()')
      expect(output).toContain('reactiveValue()')
    })
  })

  describe('Function calls with reactive args', () => {
    it('handles function calls with state arguments', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let x = $state(1)
          let y = $state(2)
          const sum = Math.max(x, y)
          return sum
        }
      `
      const output = runTransform(input)
      expect(output).toContain('Math.max(x(), y())')
    })

    it('handles method calls on state', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let text = $state('hello')
          const upper = text.toUpperCase()
          return upper
        }
      `
      const output = runTransform(input)
      expect(output).toContain('text().toUpperCase()')
      expect(output).toContain('__fictUseMemo')
    })

    it('handles array methods on state array', () => {
      const input = `
        import { $state } from 'fict'
        function Component() {
          let items = $state([1, 2, 3])
          const doubled = items.map(x => x * 2)
          const filtered = items.filter(x => x > 1)
          const first = items[0]
          return { doubled, filtered, first }
        }
      `
      const output = runTransform(input)
      expect(output).toContain('items().map')
      expect(output).toContain('items().filter')
      expect(output).toContain('items()[0]')
    })
  })
})
