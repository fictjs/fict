import { describe, expect, it } from 'vitest'

import { transform } from './test-utils'

describe('macro binding recognition', () => {
  it('does not transform a local $state binding that shadows the imported macro', () => {
    const output = transform(`
      import { $state } from 'fict'
      function App() {
        const $state = (x: number) => x
        let count = $state(0)
        return count
      }
    `)

    expect(output).not.toContain('__fictUseSignal')
    expect(output).toContain('let count = $state(0)')
    expect(output).toContain('return count')
  })

  it('allows a local $state function without a fict import', () => {
    const output = transform(`
      function App() {
        const $state = (x: number) => x
        return $state(1)
      }
    `)

    expect(output).not.toContain('__fictUseSignal')
    expect(output).toContain('return $state(1)')
  })

  it('does not add memo devtools options to a local createMemo helper', () => {
    const output = transform(`
      function createMemo<T>(fn: () => T): T {
        return fn()
      }
      function App() {
        let x = createMemo(() => 1)
        return x
      }
    `)

    expect(output).toContain('let x = createMemo(() => 1)')
    expect(output).not.toContain('devToolsSource')
  })

  it('does not report R004 for a local helper that shadows a fict import', () => {
    expect(() =>
      transform(`
        import { createEffect } from 'fict'
        function App(flag: boolean) {
          const createEffect = (fn: () => void) => fn()
          if (flag) {
            createEffect(() => {})
          }
          return null
        }
      `),
    ).not.toThrow()
  })

  it('keeps imported macro aliases active', () => {
    const output = transform(`
      import { $state as state, createMemo as memo } from 'fict'
      function App() {
        let count = state(1)
        const doubled = memo(() => count * 2)
        return doubled()
      }
    `)

    expect(output).toContain('__fictUseSignal')
    expect(output).toContain('memo(() => count() * 2')
    expect(output).toContain('devToolsSource')
  })
})
