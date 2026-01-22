import { describe, expect, it } from 'vitest'
import { transform } from './test-utils'

describe('Alias-Safe Reactive Lowering', () => {
  describe('Local Aliasing', () => {
    it('treats direct alias as memo accessor', () => {
      const source = `
        import { $state } from 'fict'
        function Component() {
          const count = $state(0)
          const alias = count
          console.log(alias)
          return alias
        }
      `
      const output = transform(source)
      expect(output).toContain('__fictUseMemo')
      expect(output).toContain('alias()')
      expect(output).toContain('console.log(alias()')
    })

    it('treats post-declaration alias as memo accessor', () => {
      const source = `
        import { $state } from 'fict'
        function Component() {
          let count = $state(0)
          let alias
          alias = count
          console.log(alias)
          return alias
        }
      `
      const output = transform(source)
      expect(output).toContain('__fictUseMemo')
      expect(output).toContain('alias = __fictUseMemo')
      expect(output).toContain('console.log(alias()')
    })

    it('disallows reassignment of reactive alias', () => {
      const source = `
        import { $state } from 'fict'
        function Component() {
          let count = $state(0)
          let alias = count
          alias = 1
          return alias
        }
      `
      expect(() => transform(source)).toThrow(/Alias reassignment is not supported/)
    })

    it('disallows reassignment after post-declaration alias', () => {
      const source = `
        import { $state } from 'fict'
        function Component() {
          let count = $state(0)
          let alias
          alias = count
          alias = 1
          return alias
        }
      `
      expect(() => transform(source)).toThrow(/Alias reassignment is not supported/)
    })

    it('handles alias usage in JSX', () => {
      const source = `
        import { $state } from 'fict'
        export function App() {
          const count = $state(0)
          const alias = count
          return <div>{alias}</div>
        }
      `
      const output = transform(source)
      expect(output).toContain('bindText')
      expect(output).toContain('count()')
    })
  })

  describe('Exported State', () => {
    it('rejects exporting state variable as module singleton', () => {
      const source = `
        import { $state } from 'fict'
        export const count = $state(0)
      `
      expect(() => transform(source)).toThrow('component or hook function body')
    })

    it('rejects exporting let state variable as module singleton', () => {
      const source = `
        import { $state } from 'fict'
        export let count = $state(0)
      `
      expect(() => transform(source)).toThrow('component or hook function body')
    })

    it('rejects exporting derived value from module-level state', () => {
      const source = `
        import { $state } from 'fict'
        const count = $state(0)
        export const double = count * 2
      `
      expect(() => transform(source)).toThrow('component or hook function body')
    })

    it('rejects exporting alias of module-level state', () => {
      const source = `
        import { $state } from 'fict'
        const count = $state(0)
        export const alias = count
      `
      expect(() => transform(source)).toThrow('component or hook function body')
    })
  })

  describe('Destructuring existing state', () => {
    it('rewrites destructured fields to memoized getters (read-only)', () => {
      const source = `
        import { $state } from 'fict'
        export function App() {
          const counter = $state({ count: 0 })
          const { count } = counter
          const double = count * 2
          return <div>{count}{double}</div>
        }
      `
      const output = transform(source)
      expect(output).toContain('__fictUseMemo(__fictCtx, () => counter().count')
      expect(output).toContain('count()')
      expect(output).toContain('double()')
      expect(output).not.toContain('const count = counter().count')
    })
  })

  describe('Component props destructuring', () => {
    it('keeps destructured props reactive via prop + memo', () => {
      const source = `
        import { $state, render } from 'fict'

        const Counter1 = ({ count, update }) => {
          const doubled = count * 2
          return (
            <div>
              <h1>Count: {count}</h1>
              <h2>Double: {doubled}</h2>
              <button onClick={() => update()}>Increment</button>
            </div>
          )
        }

        export default function Counter() {
          let counter = $state({ count: 0 })
          return (
            <Counter1
              count={counter.count}
              update={() => {
                counter = { count: counter.count + 1 }
              }}
            />
          )
        }
      `

      const output = transform(source)
      expect(output).toContain('const count = prop(() => __props.count)')
      expect(output).toContain('__fictUseMemo(__fictCtx, () => count() * 2')
      expect(output).not.toContain('const update = prop')
    })
  })
})
