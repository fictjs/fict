import { describe, expect, it } from 'vitest'

import { transform } from './test-utils'

function doWhileFallbackBody(prefix = '', returnExpr = 'i'): string {
  return `
    ${prefix}
    let i = $state(0)

    do {
      i++
      if (i === 3) {
        continue
      }
    } while (i < 5)

    return ${returnExpr}
  `
}

describe('state-machine fallback generated name collisions', () => {
  it('renames fallback state variables when source locals use __state', () => {
    const output = transform(
      `
        import { $state } from 'fict'

        export function useRun() {
          ${doWhileFallbackBody(
            `let __state = (globalThis as any).__fictStateCollision ?? 'user'`,
            `__state + ':' + i`,
          )}
        }
      `,
      { dev: false, optimize: true },
    )

    expect(output).toContain('let __state, i;')
    expect(output).toContain('__state = globalThis.__fictStateCollision ?? "user";')
    expect(output).toMatch(/let __state_1 = \d+;/)
    expect(output).toContain('switch (__state_1)')
    expect(output).toMatch(/__state_1 = \d+;/)
  })

  it('renames fallback state variables when params use __state', () => {
    const output = transform(
      `
        import { $state } from 'fict'

        export function useRun(__state: string) {
          ${doWhileFallbackBody('', `__state + ':' + i`)}
        }
      `,
      { dev: false, optimize: true },
    )

    expect(output).toMatch(/function useRun\(__state\)/)
    expect(output).toMatch(/let __state_1 = \d+;/)
    expect(output).toContain('switch (__state_1)')
  })

  it('keeps default fallback state names for unrelated nested-scope declarations', () => {
    const output = transform(
      `
        import { $state } from 'fict'

        export function useRun() {
          function readNested() {
            let __state = 'nested'
            return __state
          }
          ${doWhileFallbackBody('', `readNested() + ':' + i`)}
        }
      `,
      { dev: false, optimize: true },
    )

    expect(output).toMatch(/let __state = \d+;/)
    expect(output).not.toMatch(/let __state_1 = \d+;/)
  })
})
