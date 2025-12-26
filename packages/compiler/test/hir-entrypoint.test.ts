import { describe, expect, it } from 'vitest'
import { transformHIR } from './test-utils'

describe('HIR entrypoint (default)', () => {
  it('lowers $state and assignments via HIR pipeline', () => {
    const code = transformHIR(
      `
        import { $state } from 'fict'
        function Counter() {
          let count = $state(0)
          count = count + 1
          return count
        }
      `,
    )

    expect(code).toContain('__fictUseSignal(__fictCtx')
    expect(code).toContain('count(count() + 1)')
    expect(code).toContain('return count()')
  })

  it('handles $effect and JSX bindings', () => {
    const code = transformHIR(
      `
        import { $state, $effect } from 'fict'
        function View() {
          const count = $state(0)
          $effect(() => { console.log(count) })
          return <div className={count}>{count}</div>
        }
      `,
    )

    expect(code).toContain('__fictUseEffect(__fictCtx')
    expect(code).toContain('bindClass')
    expect(code).toContain('count()')
  })

  it('applies region dependency getters to property reads in JSX', () => {
    const code = transformHIR(
      `
        import { $state } from 'fict'
        function View() {
          const state = $state({ user: { name: 'Ada' } })
        return <div className={state.user.name}>{state.user.name}</div>
      }
    `,
    )

    expect(code).toContain('state().user.name')
    expect(code).toContain('bindClass')
  })
})
