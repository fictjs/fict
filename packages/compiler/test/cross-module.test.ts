import { describe, expect, it } from 'vitest'

import { type FictCompilerOptions } from '../src/index'
import { transform } from './test-utils'

describe('Cross-Module Reactivity', () => {
  describe('Store Module (Exports)', () => {
    it('exports state as signal accessor', () => {
      const source = `
        import { $state } from 'fict'
        export let count = $state(0)
      `
      const output = transform(source)
      expect(output).toContain('export const count = __fictUseSignal(__fictCtx, 0)')
    })

    it('exports derived value as memo accessor', () => {
      const source = `
        import { $state } from 'fict'
        const count = $state(0)
        export const double = count * 2
      `
      const output = transform(source)
      // Expecting standard JS export of the variable holding the memo
      expect(output).toContain('export const double = __fictUseMemo(__fictCtx, () => count() * 2')
    })

    it('re-exports state (valid JS)', () => {
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

      // Should verify that the compiler allows the function call to pass through
      // and binds it as a reactive text node.
      // Since 'count' is not a local $state, the compiler sees it as a function call expression.
      // In fine-grained mode, expressions that are functions might need special handling
      // OR standard handling if they return a value.

      // If 'count()' is an expression, 'emitDynamicTextChild' will wrap it in a getter?
      // Template cloning uses insert for dynamic content
      expect(output).toContain('insert')
      expect(output).toMatch(/children: \[\s*count\(\)\s*\]|insert.*count\(\)/)
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
      expect(output).toContain('__fictUseEffect(__fictCtx, () => {')
      expect(output).toContain('console.log(count())')
    })
  })
})
