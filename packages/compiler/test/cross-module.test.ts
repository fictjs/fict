import { describe, expect, it } from 'vitest'

import { type FictCompilerOptions } from '../src/index'
import { transform } from './test-utils'

describe('Cross-Module Reactivity', () => {
  describe('Store Module (Exports)', () => {
    it('rejects exporting module-level state', () => {
      const source = `
        import { $state } from 'fict'
        export let count = $state(0)
      `
      expect(() => transform(source)).toThrow(
        'must be declared inside a component or hook function body',
      )
    })

    it('rejects exporting module-level derived value', () => {
      const source = `
        import { $state } from 'fict'
        const count = $state(0)
        export const double = count * 2
      `
      expect(() => transform(source)).toThrow(
        'must be declared inside a component or hook function body',
      )
    })

    it('re-exports state (valid JS) is untouched', () => {
      const source = `
        export { count } from './store'
      `
      const output = transform(source)
      // Compiler should touch this, it's just value re-export
      expect(output).toContain("export { count } from './store'")
    })

    it('re-exports alias without creating new signal', () => {
      const source = `
        import { count } from './store'
        export const alias = count
        export { alias as total }
      `
      const output = transform(source)
      expect(output).toContain('export let alias = count')
      expect(output).toContain('export { alias as total }')
      // ensure no signal/memo is created for alias
      expect(output).not.toMatch(/__fictUseSignal\(|__fictUseMemo\(/)
    })
  })

  describe('Component Module (Imports)', () => {
    it('compiles component using imported signal as function call', () => {
      const source = `
        import { count } from './store'
        export function App() {
          return <div>{count()}</div>
        }
      `
      const output = transform(source, { fineGrainedDom: true })

      // The call should flow through unchanged and be bound reactively.
      // We now treat call expressions as dynamic children (not plain text) to avoid
      // misclassifying helpers that return arrays/JSX. Verify the insert path.
      expect(output).toContain('insert')
      expect(output).toMatch(/count\(\)/)
    })

    it('compiles usage of imported symbol in effect', () => {
      const source = `
        import { $effect } from 'fict'
        import { count } from './store'

        $effect(() => {
          console.log(count())
        })
      `
      const output = transform(source)
      // Should compile effect correctly
      expect(output).toContain('createEffect(() => {')
      expect(output).toContain('console.log(count())')
    })
  })
})
