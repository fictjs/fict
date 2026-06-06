import { describe, expect, it } from 'vitest'

import { transform } from './test-utils'

describe('runtime context local name collisions', () => {
  it('renames component context locals when the body declares __fictCtx', () => {
    const output = transform(
      `
        import { $state } from 'fict'

        export function App() {
          const __fictCtx = 'user'
          let count = $state(1)
          return <span>{__fictCtx}:{count}</span>
        }
      `,
      { dev: false, optimize: true },
    )

    expect(output).toContain('const __fictCtx_1 = __fictUseContext();')
    expect(output).toContain('const __fictCtx = "user";')
    expect(output).toMatch(/__fictUseSignal\(__fictCtx_1, 1/)
  })

  it('renames hook context locals when a parameter is named __fictCtx', () => {
    const output = transform(
      `
        import { $state } from 'fict'

        export function useProbe(__fictCtx: string) {
          let count = $state(1)
          return count
        }
      `,
      { dev: false, optimize: true },
    )

    expect(output).toMatch(/function useProbe\(__fictCtx\)/)
    expect(output).toContain('const __fictCtx_1 = __fictUseContext();')
    expect(output).toMatch(/__fictUseSignal\(__fictCtx_1, 1/)
  })

  it('renames effect-only component context locals', () => {
    const output = transform(
      `
        import { $effect } from 'fict'

        export function App() {
          const __fictCtx = 'user'
          $effect(() => {
            void __fictCtx
          })
          return <span>ok</span>
        }
      `,
      { dev: false, optimize: true },
    )

    expect(output).toContain('const __fictCtx_1 = __fictUseContext();')
    expect(output).toMatch(/__fictUseEffect\(__fictCtx_1, \(\) =>/)
    expect(output).toContain('const __fictCtx = "user";')
  })

  it('renames DOM memo context locals', () => {
    const output = transform(
      `
        import { $state } from 'fict'

        export function App() {
          const __fictCtx = 'user'
          let count = $state(1)
          return <span>{__fictCtx}:{count}</span>
        }
      `,
      { dev: false, optimize: true },
    )

    expect(output).toContain('const __fictCtx_1 = __fictUseContext();')
    expect(output).toMatch(/__fictUseMemo\(__fictCtx_1, \(\) =>/)
    expect(output).toContain('const __fictCtx = "user";')
  })

  it('keeps the default context local name in independent functions without collisions', () => {
    const output = transform(
      `
        import { $state } from 'fict'

        export function First() {
          let count = $state(1)
          return <span>{count}</span>
        }

        export function Second() {
          let count = $state(2)
          return <span>{count}</span>
        }
      `,
      { dev: false, optimize: true },
    )

    expect(output.match(/const __fictCtx = __fictUseContext\(\);/g)).toHaveLength(2)
    expect(output).not.toContain('__fictCtx_1')
  })
})
