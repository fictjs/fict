import { describe, expect, it } from 'vitest'

import * as runtimeInternal from '../../runtime/src/internal'

import { transformCommonJS } from './test-utils'

function compileAndRun<T>(source: string, exportName: string, args: unknown[] = []): T {
  const output = transformCommonJS(source, {
    dev: false,
    emitModuleMetadata: false,
    strictGuarantee: false,
  })

  const module: { exports: Record<string, unknown> } = { exports: {} }
  const wrapped = new Function('require', 'module', 'exports', output)

  wrapped(
    (id: string) => {
      if (id === '@fictjs/runtime/internal' || id === 'fict') {
        return runtimeInternal
      }
      throw new Error(`Unexpected import in compiler binding test: ${id}`)
    },
    module,
    module.exports,
  )

  return runtimeInternal.__fictRender({ slots: [], cursor: 0 }, () =>
    (module.exports[exportName] as (...innerArgs: unknown[]) => T)(...args),
  )
}

describe('binding shadowing runtime regressions', () => {
  it('keeps nested function locals from rewriting to outer signals', () => {
    const fn = compileAndRun<() => number>(
      `
        import { $state } from 'fict'

        export function Comp() {
          let count = $state(0)
          const fn = () => {
            let count = 1
            count++
            return count
          }
          return fn
        }
      `,
      'Comp',
    )

    expect(fn()).toBe(2)
  })

  it('keeps catch parameters from rewriting to outer signals', () => {
    const fn = compileAndRun<() => number>(
      `
        import { $state } from 'fict'

        export function Comp() {
          let count = $state(0)
          const fn = () => {
            try {
              throw 1
            } catch (count) {
              return count
            }
          }
          return fn
        }
      `,
      'Comp',
    )

    expect(fn()).toBe(1)
  })

  it('keeps top-level catch parameters from rewriting to outer signals', () => {
    const value = compileAndRun<number>(
      `
        import { $state } from 'fict'

        export function Comp() {
          let count = $state(0)
          try {
            throw 1
          } catch (count) {
            return count
          }
        }
      `,
      'Comp',
    )

    expect(value).toBe(1)
  })

  it('keeps for-of loop bindings from rewriting to outer signals', () => {
    const total = compileAndRun<number>(
      `
        import { $state } from 'fict'

        export function Comp(items) {
          let count = $state(0)
          let total = 0
          for (const count of items) {
            total += count
          }
          return total
        }
      `,
      'Comp',
      [[1, 2, 3]],
    )

    expect(total).toBe(6)
  })

  it('keeps for-in loop bindings from rewriting to outer signals', () => {
    const keys = compileAndRun<string>(
      `
        import { $state } from 'fict'

        export function Comp(obj) {
          let count = $state(0)
          let keys = []
          for (const count in obj) {
            keys.push(count)
          }
          return keys.join(',')
        }
      `,
      'Comp',
      [{ a: 1, b: 2 }],
    )

    expect(keys).toBe('a,b')
  })
})
