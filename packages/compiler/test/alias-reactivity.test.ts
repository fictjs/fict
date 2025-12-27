import { describe, expect, it } from 'vitest'
import { transform } from './test-utils'

describe('Alias-Safe Reactive Lowering', () => {
  describe('Local Aliasing', () => {
    it('transforms local alias to value capture', () => {
      const source = `
        import { $state } from 'fict'
        const count = $state(0)
        const alias = count
        console.log(alias)
      `
      const output = transform(source)
      // Alias captures the current value, not a reactive getter
      expect(output).toContain('alias = count()')
      expect(output).toContain('console.log(alias')
    })

    it('allows reassignment of alias since it is a plain value', () => {
      const source = `
        import { $state } from 'fict'
        let count = $state(0)
        let alias = count
        alias = 1
      `
      // Alias is just a value, reassignment is allowed
      const output = transform(source)
      expect(output).toContain('alias = 1')
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
      // Template cloning uses insert with marker for dynamic content
      expect(output).toContain('insert(')
      expect(output).toContain('alias()')
    })
  })

  describe('Exported State', () => {
    it('exports state variable as-is (accessor)', () => {
      const source = `
        import { $state } from 'fict'
        export const count = $state(0)
      `
      const output = transform(source)
      expect(output).toContain('export const count = __fictUseSignal(__fictCtx, 0)')
    })

    it('exports let state variable as-is', () => {
      const source = `
        import { $state } from 'fict'
        export let count = $state(0)
      `
      const output = transform(source)
      expect(output).toContain('export const count = __fictUseSignal(__fictCtx, 0)')
    })

    it('exports derived value as getter', () => {
      const source = `
        import { $state } from 'fict'
        const count = $state(0)
        export const double = count * 2
      `
      const output = transform(source)
      expect(output).toContain('export const double = __fictUseMemo(__fictCtx, () => count() * 2')
    })

    it('exports alias as captured value', () => {
      const source = `
        import { $state } from 'fict'
        const count = $state(0)
        export const alias = count
      `
      const output = transform(source)
      // Alias captures the current value when declared
      expect(output).toContain('export const alias = count()')
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
})
