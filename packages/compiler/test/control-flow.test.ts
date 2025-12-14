import { describe, it, expect } from 'vitest'

import { transformLegacyDom } from './test-utils'

/**
 * Helper to transform source code and return the result
 */
function transform(source: string): string {
  return transformLegacyDom(source)
}

describe('Fict Compiler - Control Flow', () => {
  describe('Conditional expressions', () => {
    it('handles conditional in JSX (&&)', () => {
      const input = `
        import { $state } from 'fict'
        let show = $state(true)
        const el = <div>{show && <Modal />}</div>
      `
      const output = transform(input)
      // Should wrap the conditional in an arrow function
      expect(output).toContain('() => show()')
    })

    it('handles ternary operator in JSX', () => {
      const input = `
        import { $state } from 'fict'
        let condition = $state(true)
        const el = <div>{condition ? <A /> : <B />}</div>
      `
      const output = transform(input)
      // Should wrap the ternary in an arrow function
      expect(output).toContain('() => condition()')
    })

    it('handles conditional assignment in component', () => {
      const input = `
        import { $state } from 'fict'
        let count = $state(0)
        const status = count > 10 ? 'high' : 'low'
      `
      const output = transform(input)
      // Ternary derived should be memoized
      expect(output).toContain('__fictMemo')
      expect(output).toContain('count() > 10')
    })
  })

  describe('List rendering', () => {
    it('handles array map in JSX with key (keyed list)', () => {
      const input = `
        import { $state } from 'fict'
        let items = $state([1, 2, 3])
        const el = <ul>{items.map(item => <li key={item}>{item}</li>)}</ul>
      `
      const output = transform(input)
      // Should use keyed list container helpers
      expect(output).toContain('__fictCreateKeyedListContainer')
      // Should have getItems arrow function
      expect(output).toContain('() => items()')
      // Should have keyFn
      expect(output).toContain('(item')
    })

    it('handles keyed list with object property as key', () => {
      const input = `
        import { $state } from 'fict'
        let users = $state([{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }])
        const el = <ul>{users.map(user => <li key={user.id}>{user.name}</li>)}</ul>
      `
      const output = transform(input)
      // Should use keyed list container helpers
      expect(output).toContain('__fictCreateKeyedListContainer')
      // Should extract user.id as key
      expect(output).toContain('user.id')
    })

    it('handles list without key (fallback to old createList)', () => {
      const input = `
        import { $state } from 'fict'
        let items = $state([1, 2, 3])
        const el = <ul>{items.map(item => <li>{item}</li>)}</ul>
      `
      const output = transform(input)
      // Should use old createList (not keyed)
      expect(output).toContain('__fictList')
      // Should NOT use keyed list helpers
      expect(output).not.toContain('__fictCreateKeyedListContainer')
    })

    it('handles array map with index', () => {
      const input = `
        import { $state } from 'fict'
        let items = $state(['a', 'b', 'c'])
        const list = items.map((item, i) => \`\${i}: \${item}\`)
      `
      const output = transform(input)
      expect(output).toContain('items().map')
    })

    it('handles nested derived values in map', () => {
      const input = `
        import { $state } from 'fict'
        let multiplier = $state(2)
        let numbers = $state([1, 2, 3])
        const doubled = numbers.map(n => n * multiplier)
      `
      const output = transform(input)
      // Both state variables should be transformed
      expect(output).toContain('multiplier()')
      expect(output).toContain('numbers()')
    })
  })

  describe('If statements with derived values', () => {
    it('handles derived values in if block', () => {
      const input = `
        import { $state } from 'fict'
        let count = $state(0)
        let message
        if (count > 10) {
          message = 'High'
        } else {
          message = 'Low'
        }
      `
      const output = transform(input)
      // count should be transformed in conditional
      expect(output).toContain('count() > 10')
      // message is not derived, should not be wrapped
      expect(output).not.toContain('__fictMemo')
    })

    it('handles const derived in if block', () => {
      const input = `
        import { $state } from 'fict'
        let count = $state(0)
        if (count > 0) {
          const message = \`Count: \${count}\`
        }
      `
      const output = transform(input)
      // const in if block referencing state should be memoized
      expect(output).toContain('count()')
    })
  })

  describe('Switch statements', () => {
    it('handles switch with state variable', () => {
      const input = `
        import { $state } from 'fict'
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
      `
      const output = transform(input)
      expect(output).toContain('status()')
    })
  })

  describe('Loops and derived values', () => {
    it('handles for loop with state read', () => {
      const input = `
        import { $state } from 'fict'
        let max = $state(10)
        let sum = 0
        for (let i = 0; i < max; i++) {
          sum += i
        }
      `
      const output = transform(input)
      // max should be read with getter in condition
      expect(output).toContain('max()')
    })

    it('handles for-of loop with state array', () => {
      const input = `
        import { $state } from 'fict'
        let items = $state([1, 2, 3])
        let sum = 0
        for (const item of items) {
          sum += item
        }
      `
      const output = transform(input)
      expect(output).toContain('items()')
    })

    it('throws error for $state declaration in for loop', () => {
      const input = `
        import { $state } from 'fict'
        for (let i = 0; i < 10; i++) {
          let count = $state(0)
        }
      `
      expect(() => transform(input)).toThrow('cannot be declared inside loops')
    })
  })

  describe('Nested control flow', () => {
    it('handles nested conditionals', () => {
      const input = `
        import { $state } from 'fict'
        let a = $state(1)
        let b = $state(2)
        const result = a > 0 ? (b > 0 ? 'both positive' : 'a positive') : 'a not positive'
      `
      const output = transform(input)
      expect(output).toContain('a()')
      expect(output).toContain('b()')
      expect(output).toContain('__fictMemo')
    })

    it('handles conditional in map', () => {
      const input = `
        import { $state } from 'fict'
        let items = $state([1, 2, 3, 4, 5])
        let threshold = $state(3)
        const filtered = items.map(x => x > threshold ? 'high' : 'low')
      `
      const output = transform(input)
      expect(output).toContain('items()')
      expect(output).toContain('threshold()')
    })
  })
})

describe('Fict Compiler - Complex Scenarios', () => {
  describe('Mixed reactive and non-reactive', () => {
    it('handles mix of reactive and static values', () => {
      const input = `
        import { $state } from 'fict'
        let count = $state(0)
        const staticValue = 42
        const combined = count + staticValue
      `
      const output = transform(input)
      expect(output).toContain('count() + staticValue')
      expect(output).toContain('__fictMemo')
    })

    it('handles reactive in some branches, not others', () => {
      const input = `
        import { $state } from 'fict'
        let useReactive = $state(true)
        let reactiveValue = $state(10)
        const result = useReactive ? reactiveValue : 5
      `
      const output = transform(input)
      expect(output).toContain('useReactive()')
      expect(output).toContain('reactiveValue()')
    })
  })

  describe('Function calls with reactive args', () => {
    it('handles function calls with state arguments', () => {
      const input = `
        import { $state } from 'fict'
        let x = $state(1)
        let y = $state(2)
        const sum = Math.max(x, y)
      `
      const output = transform(input)
      expect(output).toContain('Math.max(x(), y())')
      expect(output).toContain('__fictMemo')
    })

    it('handles method calls on state', () => {
      const input = `
        import { $state } from 'fict'
        let text = $state('hello')
        const upper = text.toUpperCase()
      `
      const output = transform(input)
      expect(output).toContain('text().toUpperCase()')
      expect(output).toContain('__fictMemo')
    })

    it('handles array methods on state array', () => {
      const input = `
        import { $state } from 'fict'
        let items = $state([1, 2, 3])
        const doubled = items.map(x => x * 2)
        const filtered = items.filter(x => x > 1)
        const first = items[0]
      `
      const output = transform(input)
      expect(output).toContain('items().map')
      expect(output).toContain('items().filter')
      expect(output).toContain('items()[0]')
    })
  })
})
