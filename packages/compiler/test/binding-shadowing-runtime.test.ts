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
      if (id === '@fictjs/runtime/internal' || id === 'fict/internal' || id === 'fict') {
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
  it('preserves let shadowing inside bare blocks', () => {
    const value = compileAndRun<number>(
      `
        import { $state } from 'fict'

        export function Comp() {
          let count = $state(0)
          {
            let count = 1
            return count
          }
        }
      `,
      'Comp',
    )

    expect(value).toBe(1)
  })

  it('preserves const shadowing inside bare blocks', () => {
    const value = compileAndRun<number>(
      `
        import { $state } from 'fict'

        export function Comp() {
          let count = $state(0)
          {
            const count = 2
            return count
          }
        }
      `,
      'Comp',
    )

    expect(value).toBe(2)
  })

  it('keeps bare-block let bindings from leaking after the block', () => {
    expect(() =>
      compileAndRun<number>(
        `
          import { $state } from 'fict'

          export function Comp() {
            let count = $state(0)
            {
              let value = 1
            }
            return value
          }
        `,
        'Comp',
      ),
    ).toThrow(/value is not defined/)
  })

  it('keeps bare-block function declarations from leaking after the block', () => {
    const value = compileAndRun<string>(
      `
        export function Comp() {
          {
            function local() {
              return 1
            }
          }
          return typeof local
        }
      `,
      'Comp',
    )

    expect(value).toBe('undefined')
  })

  it('keeps untaken branch function declarations from leaking or throwing', () => {
    const value = compileAndRun<string>(
      `
        export function Comp() {
          if (false) {
            function local() {
              return 1
            }
          }
          return typeof local
        }
      `,
      'Comp',
    )

    expect(value).toBe('undefined')
  })

  it('keeps bare-block class declarations from leaking after the block', () => {
    const value = compileAndRun<string>(
      `
        export function Comp() {
          {
            class Local {}
          }
          return typeof Local
        }
      `,
      'Comp',
    )

    expect(value).toBe('undefined')
  })

  it('preserves user variables with double-underscore prefixes across branches', () => {
    expect(
      compileAndRun<number>(
        `
          export function Comp(flag: boolean) {
            let __acc = 0
            if (flag) {
              __acc = 1
            } else {
              __acc = 2
            }
            return __acc
          }
        `,
        'Comp',
        [true],
      ),
    ).toBe(1)

    expect(
      compileAndRun<number>(
        `
          export function Comp(flag: boolean) {
            let __acc = 0
            if (flag) {
              __acc = 1
            } else {
              __acc = 2
            }
            return __acc
          }
        `,
        'Comp',
        [false],
      ),
    ).toBe(2)
  })

  it('keeps untaken branch class declarations from leaking or throwing', () => {
    const value = compileAndRun<string>(
      `
        export function Comp() {
          if (false) {
            class Local {}
          }
          return typeof Local
        }
      `,
      'Comp',
    )

    expect(value).toBe('undefined')
  })

  it('keeps loop class declarations from leaking after the loop', () => {
    const value = compileAndRun<string>(
      `
        export function Comp() {
          for (const item of []) {
            class Local {}
          }
          return typeof Local
        }
      `,
      'Comp',
    )

    expect(value).toBe('undefined')
  })

  it('keeps switch case class declarations from leaking after the switch', () => {
    const value = compileAndRun<string>(
      `
        export function Comp() {
          switch (0) {
            case 1:
              class Local {}
              break
          }
          return typeof Local
        }
      `,
      'Comp',
    )

    expect(value).toBe('undefined')
  })

  it('keeps var declarations function-scoped through bare blocks', () => {
    const value = compileAndRun<number>(
      `
        import { $state } from 'fict'

        export function Comp() {
          let count = $state(0)
          {
            var value = 1
          }
          return value
        }
      `,
      'Comp',
    )

    expect(value).toBe(1)
  })

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

  it('preserves returns from shadowed locals inside if branches', () => {
    const value = compileAndRun<number | (() => number)>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          if (true) {
            let count = 1
            return count
          }
          return count
        }
      `,
      'useRun',
    )

    const resolved = typeof value === 'function' ? value() : value
    expect(resolved).toBe(1)
  })

  it('preserves returns from shadowed locals inside switch cases', () => {
    const value = compileAndRun<number | (() => number)>(
      `
        import { $state } from 'fict'

        export function useRun(mode) {
          let count = $state(0)
          switch (mode) {
            case 1: {
              const count = 2
              return count
            }
            default:
              return count
          }
        }
      `,
      'useRun',
      [1],
    )

    const resolved = typeof value === 'function' ? value() : value
    expect(resolved).toBe(2)
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
