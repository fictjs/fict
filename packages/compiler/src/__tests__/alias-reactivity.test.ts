import { describe, expect, it } from 'vitest'

import { transformFineGrained } from './test-utils'

const transform = (source: string) => {
  return transformFineGrained(source)
}

describe('Alias-Safe Reactive Lowering', () => {
  describe('Local Aliasing', () => {
    it('transforms local alias to getter', () => {
      const source = `
        import { $state } from 'fict'
        const count = $state(0)
        const alias = count
        console.log(alias)
      `
      const output = transform(source)
      expect(output).toContain('const alias = () => count()')
      expect(output).toContain('console.log(alias())')
    })

    it('prevents reassignment of alias', () => {
      const source = `
        import { $state } from 'fict'
        const count = $state(0)
        const alias = count
        alias = 1
      `
      expect(() => transform(source)).toThrow(/reassignment is not supported/)
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
      // In fine-grained mode, it binds the alias getter function
      expect(output).toContain('__fictBindText(__fg0_txt0, () => alias())')
    })
  })

  describe('Exported State', () => {
    it('exports state variable as-is (accessor)', () => {
      const source = `
        import { $state } from 'fict'
        export const count = $state(0)
      `
      const output = transform(source)
      expect(output).toContain('export const count = __fictSignal(0)')
    })

    it('exports let state variable as-is', () => {
      const source = `
        import { $state } from 'fict'
        export let count = $state(0)
      `
      const output = transform(source)
      expect(output).toContain('export let count = __fictSignal(0)')
    })

    it('exports derived value as getter', () => {
      const source = `
        import { $state } from 'fict'
        const count = $state(0)
        export const double = count * 2
      `
      const output = transform(source)
      expect(output).toContain('export const double = __fictMemo(() => count() * 2)')
    })

    it('exports alias as reactive getter', () => {
      const source = `
        import { $state } from 'fict'
        const count = $state(0)
        export const alias = count
      `
      const output = transform(source)
      expect(output).toContain('export const alias = () => count()')
    })
  })
})
