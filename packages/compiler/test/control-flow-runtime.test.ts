import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import * as runtimeInternal from '../../runtime/src/internal'

import { transformCommonJS } from './test-utils'

function compileAndRunHook<T>(
  source: string,
  exportName: string,
  options: Parameters<typeof transformCommonJS>[1] = {},
  args: unknown[] = [],
  modules: Record<string, unknown> = {},
): T {
  const output = transformCommonJS(source, {
    dev: false,
    emitModuleMetadata: false,
    strictGuarantee: false,
    ...options,
  })

  const module: { exports: Record<string, unknown> } = { exports: {} }
  const wrapped = new Function('require', 'module', 'exports', output)

  wrapped(
    (id: string) => {
      if (Object.prototype.hasOwnProperty.call(modules, id)) {
        return modules[id]
      }
      if (id === '@fictjs/runtime/internal' || id === 'fict/internal' || id === 'fict') {
        return runtimeInternal
      }
      throw new Error(`Unexpected import in compiler runtime test: ${id}`)
    },
    module,
    module.exports,
  )

  const hook = module.exports[exportName]
  if (typeof hook !== 'function') {
    throw new Error(`Expected export ${exportName} to be a function`)
  }

  return runtimeInternal.__fictRender({ slots: [], cursor: 0 }, () =>
    (hook as (...innerArgs: unknown[]) => T)(...args),
  )
}

const optimizeModes = [true, false] as const

describe('control flow runtime regressions', () => {
  beforeEach(() => {
    runtimeInternal.__fictResetContext()
  })

  afterEach(() => {
    runtimeInternal.__fictResetContext()
  })

  it('preserves mutable loop accumulators inside reactive hooks', () => {
    const result = compileAndRunHook<number | (() => number)>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let n = $state(4)
          let total = 0

          for (let i = 0; i < n; i++) {
            if (i === 1) {
              continue
            }
            total += i
          }

          return total
        }
      `,
      'useRun',
    )

    const resolved = typeof result === 'function' ? result() : result
    expect(resolved).toBe(5)
  })

  it('re-runs for loop initializers inside reactive hook regions', () => {
    const result = compileAndRunHook<{
      set: (next: number) => void
      starts: () => number
      view: () => string
    }>(
      `
        import { $state } from 'fict'

        function begin() {
          ;(globalThis as any).__fictForInitStarts =
            ((globalThis as any).__fictForInitStarts ?? 0) + 1
          return 0
        }

        export function useRun() {
          ;(globalThis as any).__fictForInitStarts = 0
          let n = $state(2)
          let out = ''

          for (let i = begin(); i < n; i++) {
            out += i
          }

          return {
            set: (next: number) => {
              n = next
            },
            starts: () => (globalThis as any).__fictForInitStarts ?? 0,
            view: () => out,
          }
        }
      `,
      'useRun',
    )

    expect(result.view()).toBe('01')
    expect(result.starts()).toBe(1)

    result.set(3)
    expect(result.view()).toBe('012')
    expect(result.starts()).toBe(2)

    result.set(1)
    expect(result.view()).toBe('0')
    expect(result.starts()).toBe(3)

    result.set(3)
    expect(result.view()).toBe('012')
    expect(result.starts()).toBe(4)
  })

  it('preserves for-of continue semantics at iterator body entry', () => {
    const result = compileAndRunHook<{ toggle: () => void; view: () => number }>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let mode = $state(0)
          let visited = 0

          for (const cell of mode === 0 ? [2] : [2, 3]) {
            let current = cell
            if (current-- === 2) {
              continue
            }
            visited += 1
          }

          return {
            toggle: () => {
              mode = 1
            },
            view: () => visited,
          }
        }
      `,
      'useRun',
    )

    expect(result.view()).toBe(0)
    result.toggle()
    expect(result.view()).toBe(1)
  })

  it('preserves for-in continue semantics at iterator body entry', () => {
    const result = compileAndRunHook<{ toggle: () => void; view: () => string }>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let mode = $state(0)
          let seen = ''
          const source = mode === 0 ? { a: 2 } : { a: 2, b: 3 }

          for (const key in source) {
            let current = source[key]
            if (current-- === 2) {
              continue
            }
            seen += key + current
          }

          return {
            toggle: () => {
              mode = 1
            },
            view: () => seen,
          }
        }
      `,
      'useRun',
    )

    expect(result.view()).toBe('')
    result.toggle()
    expect(result.view()).toBe('b2')
  })

  it('preserves for-in assignment targets on existing let bindings', () => {
    const result = compileAndRunHook<string>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let tick = $state(0)
          let key = ''

          for (key in { a: 1, b: 2 }) {}

          return key
        }
      `,
      'useRun',
    )

    expect(result).toBe('b')
  })

  it('preserves for-of assignment targets on existing var bindings', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let tick = $state(0)
          var value = 0

          for (value of [1, 2]) {}

          return value
        }
      `,
      'useRun',
    )

    expect(result).toBe(2)
  })

  it('preserves for-of assignment targets from outer scopes', () => {
    const result = compileAndRunHook<string>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let tick = $state(0)
          let value = ''

          {
            for (value of ['x', 'y']) {}
          }

          return value
        }
      `,
      'useRun',
    )

    expect(result).toBe('y')
  })

  it('preserves for-of assignment targets on state bindings', () => {
    const result = compileAndRunHook<number | (() => number)>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let value = $state(0)

          for (value of [1, 2]) {}

          return value
        }
      `,
      'useRun',
    )

    const resolved = typeof result === 'function' ? result() : result
    expect(resolved).toBe(2)
  })

  it('preserves for-of member expression loop targets', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let tick = $state(0)
          const obj = { value: 0 }

          for (obj.value of [1, 2]) {}

          return obj.value
        }
      `,
      'useRun',
    )

    expect(result).toBe(2)
  })

  it('preserves for-in member expression loop targets', () => {
    const result = compileAndRunHook<string>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let tick = $state(0)
          const obj = { key: '' }

          for (obj.key in { a: 1, b: 2 }) {}

          return obj.key
        }
      `,
      'useRun',
    )

    expect(result).toBe('b')
  })

  it('preserves computed member loop targets', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let tick = $state(0)
          const prop = 'value'
          const obj = { value: 0 }

          for (obj[prop] of [1, 2]) {}

          return obj.value
        }
      `,
      'useRun',
    )

    expect(result).toBe(2)
  })

  it('preserves store member loop targets', () => {
    const result = compileAndRunHook<number>(
      `
        import { createStore } from 'fict'

        export function useRun() {
          const [state] = createStore({ value: 0 })

          for (state.value of [1, 2]) {}

          return state.value
        }
      `,
      'useRun',
    )

    expect(result).toBe(2)
  })

  it('keeps partial while-loop control flow inline when memoization would be incomplete', () => {
    const result = compileAndRunHook<number | (() => number)>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let n = $state(3)
          let total = 0
          let i = 0

          while (i < n) {
            total += 1
            i++
          }

          return total
        }
      `,
      'useRun',
    )

    const resolved = typeof result === 'function' ? result() : result
    expect(resolved).toBe(3)
  })

  it('recomputes reactive while loop bounds synchronously', () => {
    const result = compileAndRunHook<{
      set: (next: number) => void
      view: () => string
    }>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let n = $state(2)
          let out = ''
          let i = 0

          while (i < n) {
            out += i
            i++
          }

          return {
            set: (next: number) => {
              n = next
            },
            view: () => out,
          }
        }
      `,
      'useRun',
    )

    expect(result.view()).toBe('01')

    result.set(3)
    expect(result.view()).toBe('012')

    result.set(1)
    expect(result.view()).toBe('0')

    result.set(3)
    expect(result.view()).toBe('012')
  })

  it('preserves immediate while break before trailing return', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          while (true) {
            break
          }
          return 6
        }
      `,
      'useRun',
    )

    expect(result).toBe(6)
  })

  it('preserves immediate for break before trailing return', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          for (let i = 0; i < 3; i++) {
            break
          }
          return 5
        }
      `,
      'useRun',
    )

    expect(result).toBe(5)
  })

  it('keeps classic for let initializer bindings scoped to the loop', () => {
    expect(() =>
      compileAndRunHook<number>(
        `
          import { $state } from 'fict'

          export function useRun() {
            let count = $state(0)
            for (let i = 0; i < 1; i++) {}
            return i
          }
        `,
        'useRun',
      ),
    ).toThrow(/i is not defined/)
  })

  it('keeps classic for const initializer bindings scoped to the loop', () => {
    expect(() =>
      compileAndRunHook<number>(
        `
          import { $state } from 'fict'

          export function useRun() {
            let count = $state(0)
            for (const item = 0; item < 1;) {
              break
            }
            return item
          }
        `,
        'useRun',
      ),
    ).toThrow(/item is not defined/)
  })

  it('allows redeclaration after classic for let initializer bindings', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          for (let i = 0; i < 1; i++) {}
          let i = 4
          return i
        }
      `,
      'useRun',
    )

    expect(result).toBe(4)
  })

  for (const optimize of optimizeModes) {
    it(`preserves const function declarations before calls with optimize=${optimize}`, () => {
      const result = compileAndRunHook<number>(
        `
          import { $state } from 'fict'

          export function useRun() {
            let count = $state(0)
            let x = 0
            const fn = v => v
            fn(x = 1)
            return x
          }
        `,
        'useRun',
        { optimize },
      )

      expect(result).toBe(1)
    })

    it(`preserves const object declarations before method calls with optimize=${optimize}`, () => {
      const result = compileAndRunHook<number>(
        `
          import { $state } from 'fict'

          export function useRun() {
            let count = $state(0)
            let x = 0
            const obj = { fn(v) { return v } }
            obj.fn(x = 1)
            return x
          }
        `,
        'useRun',
        { optimize },
      )

      expect(result).toBe(1)
    })

    it(`preserves const function declarations before optional calls with optimize=${optimize}`, () => {
      const result = compileAndRunHook<number>(
        `
          import { $state } from 'fict'

          export function useRun() {
            let count = $state(0)
            let x = 0
            const fn = v => v
            fn?.(x = 1)
            return x
          }
        `,
        'useRun',
        { optimize },
      )

      expect(result).toBe(1)
    })

    it(`preserves hoisted function declarations after return with optimize=${optimize}`, () => {
      const result = compileAndRunHook<number>(
        `
          import { $state } from 'fict'

          export function useRun() {
            let count = $state(0)
            return fn()

            function fn() {
              return 1
            }
          }
        `,
        'useRun',
        { optimize },
      )

      expect(result).toBe(1)
    })

    it(`preserves block hoisted function declarations after return with optimize=${optimize}`, () => {
      const result = compileAndRunHook<number>(
        `
          import { $state } from 'fict'

          export function useRun() {
            let count = $state(0)
            if (true) {
              return fn()

              function fn() {
                return 2
              }
            }
            return 0
          }
        `,
        'useRun',
        { optimize },
      )

      expect(result).toBe(2)
    })

    it(`preserves try-block hoisted function declarations after throw with optimize=${optimize}`, () => {
      const result = compileAndRunHook<string>(
        `
          import { $state } from 'fict'

          export function useRun() {
            let count = $state(0)
            try {
              throw makeError()

              function makeError() {
                return new Error('ok')
              }
            } catch (err) {
              return err.message
            }
          }
        `,
        'useRun',
        { optimize },
      )

      expect(result).toBe('ok')
    })

    it(`preserves nested function hoisting after return with optimize=${optimize}`, () => {
      const result = compileAndRunHook<number>(
        `
          import { $state } from 'fict'

          export function useRun() {
            let count = $state(0)
            const run = () => {
              return fn()

              function fn() {
                return 3
              }
            }
            return run()
          }
        `,
        'useRun',
        { optimize },
      )

      expect(result).toBe(3)
    })

    it(`preserves var bindings after return with optimize=${optimize}`, () => {
      const result = compileAndRunHook<undefined>(
        `
          import { $state } from 'fict'

          export function useRun() {
            let count = $state(0)
            return x

            var x = 1
          }
        `,
        'useRun',
        { optimize },
      )

      expect(result).toBeUndefined()
    })

    it(`preserves const TDZ after return with optimize=${optimize}`, () => {
      expect(() =>
        compileAndRunHook<number>(
          `
            import { $state } from 'fict'

            export function useRun() {
              let count = $state(0)
              return typeof x

              const x = 1
            }
          `,
          'useRun',
          { optimize },
        ),
      ).toThrow(/Cannot access 'x' before initialization/)
    })

    it(`preserves class TDZ after return with optimize=${optimize}`, () => {
      expect(() =>
        compileAndRunHook<unknown>(
          `
            import { $state } from 'fict'

            export function useRun() {
              let count = $state(0)
              return C

              class C {}
            }
          `,
          'useRun',
          { optimize },
        ),
      ).toThrow(/Cannot access 'C' before initialization/)
    })

    it(`preserves var bindings after throw with optimize=${optimize}`, () => {
      const result = compileAndRunHook<string>(
        `
          import { $state } from 'fict'

          export function useRun() {
            let count = $state(0)
            try {
              throw x

              var x = 1
            } catch (err) {
              return err === undefined ? 'undefined' : 'other'
            }
          }
        `,
        'useRun',
        { optimize },
      )

      expect(result).toBe('undefined')
    })

    it(`preserves const TDZ after throw with optimize=${optimize}`, () => {
      const result = compileAndRunHook<string>(
        `
          import { $state } from 'fict'

          export function useRun() {
            let count = $state(0)
            try {
              throw typeof x

              const x = 1
            } catch (err) {
              return err instanceof ReferenceError ? err.message : 'wrong'
            }
          }
        `,
        'useRun',
        { optimize },
      )

      expect(result).toMatch(/Cannot access 'x' before initialization/)
    })

    it(`preserves class TDZ after throw with optimize=${optimize}`, () => {
      const result = compileAndRunHook<string>(
        `
          import { $state } from 'fict'

          export function useRun() {
            let count = $state(0)
            try {
              throw C

              class C {}
            } catch (err) {
              return err instanceof ReferenceError ? err.message : 'wrong'
            }
          }
        `,
        'useRun',
        { optimize },
      )

      expect(result).toMatch(/Cannot access 'C' before initialization/)
    })

    it(`preserves const object declarations before optional member calls with optimize=${optimize}`, () => {
      const result = compileAndRunHook<number>(
        `
          import { $state } from 'fict'

          export function useRun() {
            let count = $state(0)
            let x = 0
            const obj = { fn(v) { return v } }
            obj.fn?.(x = 1)
            return x
          }
        `,
        'useRun',
        { optimize },
      )

      expect(result).toBe(1)
    })

    it(`preserves source TDZ for const calls before declarations with optimize=${optimize}`, () => {
      expect(() =>
        compileAndRunHook<number>(
          `
            import { $state } from 'fict'

            export function useRun() {
              let count = $state(0)
              let x = 0
              fn(x = 1)
              const fn = v => v
              return x
            }
          `,
          'useRun',
          { optimize },
        ),
      ).toThrow(/Cannot access 'fn' before initialization/)
    })
  }

  it('preserves nested function writes to outer locals with optimization', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          let x = 0
          const fn = () => {
            x = 1
          }
          fn()
          return x
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result).toBe(1)
  })

  it('preserves synchronous array callback writes to outer locals with optimization', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          let x = 0
          ;[1].map(n => {
            x = n
          })
          return x
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result).toBe(1)
  })

  it('preserves object-hosted callback writes to outer locals with optimization', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          let x = 0
          const runner = {
            run(cb) {
              cb(1)
            },
          }
          runner.run(n => {
            x = n
          })
          return x
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result).toBe(1)
  })

  it('preserves default-parameter writes to outer locals with optimization', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          let x = 0
          const fn = (value = (x = 1)) => value
          fn()
          return x
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result).toBe(1)
  })

  it('lowers reactive reads in arrow function parameter defaults', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(1)
          const fn = (value = count) => value
          return fn()
        }
      `,
      'useRun',
    )

    expect(result).toBe(1)
  })

  it('lowers reactive reads in function expression parameter defaults', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(2)
          const fn = function (value = count) {
            return value
          }
          return fn()
        }
      `,
      'useRun',
    )

    expect(result).toBe(2)
  })

  it('lowers reactive reads in destructured parameter defaults', () => {
    const result = compileAndRunHook<number[]>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(3)
          const objectFn = ({ value = count } = {}) => value
          const arrayFn = ([value = count] = []) => value
          return [objectFn(), arrayFn()]
        }
      `,
      'useRun',
    )

    expect(result).toEqual([3, 3])
  })

  it('lowers reactive reads in computed parameter pattern keys', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let key = $state('value')
          const fn = ({ [key]: value } = { value: 4 }) => value
          return fn()
        }
      `,
      'useRun',
    )

    expect(result).toBe(4)
  })

  it('keeps parameter defaults shadowed from outer reactive values', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(1)
          const fn = (count = 2, value = count) => value
          return fn()
        }
      `,
      'useRun',
    )

    expect(result).toBe(2)
  })

  it('keeps same-name callback parameters shadowed during optimization', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          let x = 0
          ;[1].map(x => {
            x = 2
            return x
          })
          return x
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result).toBe(0)
  })

  it('preserves optimized object member delete side effects', () => {
    const result = compileAndRunHook<string>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          const obj = { a: 1 }
          const ok = delete obj.a
          return ok + ':' + ('a' in obj)
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result).toBe('true:false')
  })

  it('preserves optimized array index delete side effects', () => {
    const result = compileAndRunHook<string>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          const arr = [1]
          const ok = delete arr[0]
          return ok + ':' + (0 in arr)
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result).toBe('true:false')
  })

  it('preserves class field side effects with optimization', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          let x = 0
          class A {
            field = (x = 1)
          }
          new A()
          return x
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result).toBe(1)
  })

  it('preserves static class field side effects with optimization', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          let x = 0
          class A {
            static field = (x = 1)
          }
          return x
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result).toBe(1)
  })

  it('preserves static class block side effects with optimization', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          let x = 0
          class A {
            static {
              x = 1
            }
          }
          return x
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result).toBe(1)
  })

  it('preserves class method side effects with optimization', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          let x = 0
          class A {
            run() {
              x = 1
            }
          }
          new A().run()
          return x
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result).toBe(1)
  })

  it('lowers reactive writes inside class methods', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(1)
          class A {
            inc() {
              count = 2
              return count
            }
          }
          return new A().inc()
        }
      `,
      'useRun',
    )

    expect(result).toBe(2)
  })

  it('lowers reactive writes inside class fields', () => {
    const result = compileAndRunHook<number[]>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(1)
          class A {
            field = (count = 2)
            static value = (count = 3)
          }
          const instance = new A()
          const read = () => count
          return [A.value, instance.field, read()]
        }
      `,
      'useRun',
    )

    expect(result).toEqual([3, 2, 2])
  })

  it('lowers reactive writes inside class static blocks and setters', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(1)
          class A {
            static {
              count = 2
            }
            set value(next) {
              count = next
            }
          }
          new A().value = 3
          const read = () => count
          return read()
        }
      `,
      'useRun',
    )

    expect(result).toBe(3)
  })

  it('lowers reactive updates inside class bodies', () => {
    const result = compileAndRunHook<number[]>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(1)
          class A {
            inc() {
              return count++
            }
          }
          const previous = new A().inc()
          const read = () => count
          return [previous, read()]
        }
      `,
      'useRun',
    )

    expect(result).toEqual([1, 2])
  })

  it('keeps class method parameters shadowed from outer reactive values', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(1)
          class A {
            method(count) {
              return count
            }
          }
          return new A().method(2)
        }
      `,
      'useRun',
    )

    expect(result).toBe(2)
  })

  it('keeps class method locals shadowed from outer reactive values', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(1)
          class A {
            method() {
              const count = 2
              return count
            }
          }
          return new A().method()
        }
      `,
      'useRun',
    )

    expect(result).toBe(2)
  })

  it('keeps class method catch parameters shadowed from outer reactive values', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(1)
          class A {
            method() {
              try {
                throw 2
              } catch (count) {
                return count
              }
            }
          }
          return new A().method()
        }
      `,
      'useRun',
    )

    expect(result).toBe(2)
  })

  it('keeps object method parameters shadowed from outer reactive values', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(1)
          return {
            method(count) {
              return count
            }
          }.method(2)
        }
      `,
      'useRun',
    )

    expect(result).toBe(2)
  })

  it('keeps object method locals shadowed from outer reactive values', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(1)
          return {
            method() {
              const count = 2
              return count
            }
          }.method()
        }
      `,
      'useRun',
    )

    expect(result).toBe(2)
  })

  it('keeps object method catch parameters shadowed from outer reactive values', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(1)
          return {
            method() {
              try {
                throw 2
              } catch (count) {
                return count
              }
            }
          }.method()
        }
      `,
      'useRun',
    )

    expect(result).toBe(2)
  })

  it('keeps static block locals shadowed from outer reactive values', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(1)
          class A {
            static {
              const count = 2
              A.value = count
            }
          }
          return A.value
        }
      `,
      'useRun',
    )

    expect(result).toBe(2)
  })

  it('keeps class accessors and private methods shadowed from outer reactive values', () => {
    const result = compileAndRunHook<number[]>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(1)
          class A {
            seen = 0
            static read(count) {
              return count
            }
            #echo(count) {
              return count
            }
            get value() {
              const count = 4
              return count
            }
            set value(count) {
              this.seen = count
            }
            run() {
              this.value = 5
              return [A.read(2), this.#echo(3), this.value, this.seen]
            }
          }
          return new A().run()
        }
      `,
      'useRun',
    )

    expect(result).toEqual([2, 3, 4, 5])
  })

  it('preserves Object.assign mutations of const object fields with optimization', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          const obj = { a: 1 }
          Object.assign(obj, { a: 2 })
          return obj.a
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result).toBe(2)
  })

  it('preserves const object field writes through aliases with optimization', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          const obj = { a: 1 }
          const alias = obj
          alias.a = 2
          return obj.a
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result).toBe(2)
  })

  it('preserves const array index writes through aliases with optimization', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          const arr = [1]
          const alias = arr
          alias[0] = 2
          return arr[0]
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result).toBe(2)
  })

  it('preserves const array mutator calls through aliases with optimization', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          const arr = [1]
          const alias = arr
          alias.push(2)
          return arr.length
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result).toBe(2)
  })

  it('preserves Object.defineProperty mutations of const object fields with optimization', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          const obj = { a: 1 }
          Object.defineProperty(obj, 'a', { value: 2 })
          return obj.a
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result).toBe(2)
  })

  it('preserves Reflect.set mutations of const object fields with optimization', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          const obj = { a: 1 }
          Reflect.set(obj, 'a', 2)
          return obj.a
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result).toBe(2)
  })

  it('preserves unknown call mutations of const object fields with optimization', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        function mutate(target) {
          target.a = 2
        }

        export function useRun() {
          let count = $state(0)
          const obj = { a: 1 }
          mutate(obj)
          return obj.a
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result).toBe(2)
  })

  it('preserves unknown call mutations of const array fields with optimization', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        function mutate(target) {
          target.push(2)
        }

        export function useRun() {
          let count = $state(0)
          const arr = [1]
          mutate(arr)
          return arr.length
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result).toBe(2)
  })

  it('preserves object getter side effects with optimization', () => {
    const result = compileAndRunHook<string>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          let x = 0
          const obj = {
            get a() {
              x = 1
              return 2
            },
          }
          x = 0
          const y = obj.a
          return x + ':' + y
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result).toBe('1:2')
  })

  it('preserves computed object getter side effects with optimization', () => {
    const result = compileAndRunHook<string>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          let x = 0
          const key = 'a'
          const obj = {
            get [key]() {
              x = 1
              return 2
            },
          }
          x = 0
          const y = obj[key]
          return x + ':' + y
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result).toBe('1:2')
  })

  it('preserves object setter side effects with optimization', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          let x = 0
          const obj = {
            set a(value) {
              x = value
            },
          }
          x = 1
          obj.a = 3
          return x
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result).toBe(3)
  })

  it('preserves getter side effects in logical expressions with optimization', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          let x = 0
          const obj = {
            get a() {
              x = 1
              return false
            },
          }
          x = 0
          return obj.a || x
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result).toBe(1)
  })

  it('preserves setter side effects in compound assignments with optimization', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          let x = 0
          const obj = {
            get a() {
              return 1
            },
            set a(value) {
              x = value
            },
          }
          x = 0
          obj.a += 2
          return x
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result).toBe(3)
  })

  it('keeps accessor parameters shadowed during optimization', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          let x = 0
          const obj = {
            set a(x) {
              x = 3
            },
          }
          x = 1
          obj.a = 2
          return x
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result).toBe(1)
  })

  it('preserves tagged template raw escapes with optimization', () => {
    const result = compileAndRunHook<string>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          function tag(strings) {
            return strings.raw[0]
          }
          return tag\`a\\nb\`
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result).toBe('a\\nb')
  })

  it('preserves const tagged template tag bindings with optimization', () => {
    const result = compileAndRunHook<string>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          const tag = strings => strings.raw[0]
          return tag\`x\`
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result).toBe('x')
  })

  it('preserves member tagged template tag bindings with optimization', () => {
    const result = compileAndRunHook<string>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          const tags = { raw: strings => strings.raw[0] }
          return tags.raw\`x\`
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result).toBe('x')
  })

  it('preserves computed tagged template tag bindings with optimization', () => {
    const result = compileAndRunHook<string>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          const key = 'raw'
          const tags = { raw: strings => strings.raw[0] }
          return tags[key]\`x\`
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result).toBe('x')
  })

  it('preserves tagged template assignment and update writes with optimization', () => {
    const result = compileAndRunHook<string>(
      `
        export function useRun() {
          "use pure"
          let x = 1
          let y = 1
          const tag = (_strings, ...values) => values.join(':')
          tag\`\${x = 2}\${y++}\`
          return x + ':' + y
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result).toBe('2:2')
  })

  it('preserves tagged template member mutators with optimization', () => {
    const result = compileAndRunHook<number>(
      `
        export function useRun() {
          "use pure"
          const arr = [1]
          const tag = (_strings, value) => value
          tag\`\${arr.push(2)}\`
          return arr.length
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result).toBe(2)
  })

  it('preserves RegExp literal allocation identity with optimization', () => {
    const result = compileAndRunHook<[boolean, number, number]>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          const a = /x/g
          const b = /x/g
          a.lastIndex = 1
          return [a === b, a.lastIndex, b.lastIndex]
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result).toEqual([false, 1, 0])
  })

  it('preserves observable coercions with optimization', () => {
    expect(() =>
      compileAndRunHook<number>(
        `
          export function useRun() {
            "use pure"
            const value = {
              toString() {
                throw new Error('coerced')
              },
            }
            const text = \`\${value}\`
            void text
            return 1
          }
        `,
        'useRun',
        { optimize: true },
      ),
    ).toThrow('coerced')

    const result = compileAndRunHook<string>(
      `
        export function useRun() {
          "use pure"
          let hits = 0
          const value = {
            valueOf() {
              hits++
              return 1
            },
          }
          const unaryA = +value
          const unaryB = +value
          const binaryA = value + 1
          const binaryB = value + 1
          return hits + ':' + unaryA + ':' + unaryB + ':' + binaryA + ':' + binaryB
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result).toBe('4:1:1:2:2')
  })

  it('preserves observable spread operations with optimization', () => {
    expect(() =>
      compileAndRunHook<number>(
        `
          export function useRun() {
            "use pure"
            const source = {
              get value() {
                throw new Error('spread getter')
              },
            }
            const copy = { ...source }
            void copy
            return 1
          }
        `,
        'useRun',
        { optimize: true },
      ),
    ).toThrow('spread getter')

    expect(() =>
      compileAndRunHook<number>(
        `
          export function useRun() {
            "use pure"
            const iterable = {
              [Symbol.iterator]() {
                throw new Error('spread iterator')
              },
            }
            const copy = [...iterable]
            void copy
            return 1
          }
        `,
        'useRun',
        { optimize: true },
      ),
    ).toThrow('spread iterator')
  })

  it('preserves observable computed object keys with optimization', () => {
    expect(() =>
      compileAndRunHook<number>(
        `
          export function useRun() {
            "use pure"
            const key = {
              toString() {
                throw new Error('computed key')
              },
            }
            const obj = { [key]: 1 }
            void obj
            return 1
          }
        `,
        'useRun',
        { optimize: true },
      ),
    ).toThrow('computed key')

    expect(() =>
      compileAndRunHook<number>(
        `
          export function useRun() {
            "use pure"
            const obj = {
              [{
                [Symbol.toPrimitive]() {
                  throw new Error('inline computed key')
                },
              }]: 1,
            }
            void obj
            return 1
          }
        `,
        'useRun',
        { optimize: true },
      ),
    ).toThrow('inline computed key')
  })

  it('does not treat shadowed builtin names as optimizer builtins', () => {
    expect(() =>
      compileAndRunHook<number>(
        `
          import { Number } from './dep'

          export function useRun() {
            const value = Number(1)
            void value
            return 1
          }
        `,
        'useRun',
        { optimize: true },
        [],
        {
          './dep': {
            Number() {
              throw new Error('imported Number')
            },
          },
        },
      ),
    ).toThrow('imported Number')

    expect(() =>
      compileAndRunHook<number>(
        `
          import * as Math from './dep'

          export function useRun() {
            const value = Math.abs(1)
            void value
            return 1
          }
        `,
        'useRun',
        { optimize: true },
        [],
        {
          './dep': {
            abs() {
              throw new Error('imported Math')
            },
          },
        },
      ),
    ).toThrow('imported Math')

    const numberNamespace = {}
    Object.defineProperty(numberNamespace, 'NaN', {
      enumerable: true,
      get() {
        throw new Error('imported Number member')
      },
    })

    expect(() =>
      compileAndRunHook<number>(
        `
          import * as Number from './dep'

          export function useRun() {
            const value = Number.NaN
            void value
            return 1
          }
        `,
        'useRun',
        { optimize: true },
        [],
        {
          './dep': numberNamespace,
        },
      ),
    ).toThrow('imported Number member')

    expect(() =>
      compileAndRunHook<number>(
        `
          export function useRun(Number) {
            const value = Number(1)
            void value
            return 1
          }
        `,
        'useRun',
        { optimize: true },
        [
          () => {
            throw new Error('parameter Number')
          },
        ],
      ),
    ).toThrow('parameter Number')
  })

  it('preserves unused identifier reads that can throw under optimization', () => {
    expect(() =>
      compileAndRunHook<number>(
        `
          export function useRun() {
            const value = missing
            return 1
          }
        `,
        'useRun',
        { optimize: true },
      ),
    ).toThrow(ReferenceError)

    expect(() =>
      compileAndRunHook<number>(
        `
          export function useRun() {
            const value = void missing
            return 1
          }
        `,
        'useRun',
        { optimize: true },
      ),
    ).toThrow(ReferenceError)

    expect(() =>
      compileAndRunHook<number>(
        `
          export function useRun() {
            const value = !missing
            return 1
          }
        `,
        'useRun',
        { optimize: true },
      ),
    ).toThrow(ReferenceError)

    expect(() =>
      compileAndRunHook<number>(
        `
          export function useRun() {
            const value = y
            let y = 1
            return 1
          }
        `,
        'useRun',
        { optimize: true },
      ),
    ).toThrow(/Cannot access 'y' before initialization/)

    expect(() =>
      compileAndRunHook<number>(
        `
          export function useRun() {
            const value = C
            class C {}
            return 1
          }
        `,
        'useRun',
        { optimize: true },
      ),
    ).toThrow(/Cannot access 'C' before initialization/)

    expect(() =>
      compileAndRunHook<number>(
        `
          export function useRun() {
            const value = typeof y
            let y = 1
            return 1
          }
        `,
        'useRun',
        { optimize: true },
      ),
    ).toThrow(/Cannot access 'y' before initialization/)

    expect(
      compileAndRunHook<number>(
        `
          export function useRun() {
            const value = typeof missing
            return 1
          }
        `,
        'useRun',
        { optimize: true },
      ),
    ).toBe(1)

    expect(
      compileAndRunHook<number>(
        `
          export function useRun() {
            const value = y
            var y = 1
            return 1
          }
        `,
        'useRun',
        { optimize: true },
      ),
    ).toBe(1)

    expect(
      compileAndRunHook<number>(
        `
          import { value } from './dep'

          export function useRun(param) {
            const fromImport = value
            const fromParam = param
            const declared = 1
            const fromDeclared = declared
            return 1
          }
        `,
        'useRun',
        { optimize: true },
        [2],
        { './dep': { value: 3 } },
      ),
    ).toBe(1)
  })

  it('preserves tagged template unicode raw and cooked values with optimization', () => {
    const result = compileAndRunHook<string>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          function tag(strings) {
            return strings.raw[0] + ':' + strings[0]
          }
          return tag\`\\u0061\`
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result).toBe('\\u0061:a')
  })

  it('preserves invalid tagged template escape raw values with optimization', () => {
    const result = compileAndRunHook<string>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          function tag(strings) {
            return String(strings[0]) + ':' + strings.raw[0]
          }
          return tag\`\\u{}\`
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result).toBe('undefined:\\u{}')
  })

  it('preserves mixed tagged template raw and cooked quasis with optimization', () => {
    const result = compileAndRunHook<Array<string | number>>(
      `
        import { $state } from 'fict'

        const moduleTag = (strings, value) => [
          strings[0],
          strings.raw[0],
          value,
          strings[1],
          strings.raw[1],
        ]

        export function useRun() {
          let count = $state(0)
          return moduleTag\`\\n-\${1}-\\u{41}\\\\\`
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result).toEqual(['\n-', '\\n-', 1, '-A\\', '-\\u{41}\\\\'])
  })

  it('preserves throwing coercive builtin calls with optimization', () => {
    const cases = [
      {
        name: 'Number',
        setup: `const value = { valueOf() { throw new Error('number boom') } }`,
        expression: 'Number(value)',
      },
      {
        name: 'String',
        setup: `const value = { toString() { throw new Error('string boom') } }`,
        expression: 'String(value)',
      },
      {
        name: 'parseInt',
        setup: `const value = { toString() { throw new Error('parseInt boom') } }`,
        expression: 'parseInt(value)',
      },
      {
        name: 'parseFloat',
        setup: `const value = { toString() { throw new Error('parseFloat boom') } }`,
        expression: 'parseFloat(value)',
      },
      {
        name: 'Math.abs',
        setup: `const value = { valueOf() { throw new Error('math boom') } }`,
        expression: 'Math.abs(value)',
      },
      {
        name: 'BigInt',
        setup: '',
        expression: `BigInt('nope')`,
      },
    ]

    for (const item of cases) {
      expect(() =>
        compileAndRunHook<number>(
          `
            export function useRun() {
              ${item.setup}
              const unused = ${item.expression}
              return 1
            }
          `,
          'useRun',
          { optimize: true },
        ),
      ).toThrow()
    }
  })

  it('does not merge coercive builtin calls with object operands', () => {
    const cases: Array<{
      name: string
      method: 'toString' | 'valueOf'
      expression: string
      expected: unknown[]
    }> = [
      {
        name: 'Number',
        method: 'valueOf',
        expression: 'Number(value)',
        expected: [1, 2, 2],
      },
      {
        name: 'String',
        method: 'toString',
        expression: 'String(value)',
        expected: ['1', '2', 2],
      },
      {
        name: 'parseInt',
        method: 'toString',
        expression: 'parseInt(value)',
        expected: [1, 2, 2],
      },
      {
        name: 'parseFloat',
        method: 'toString',
        expression: 'parseFloat(value)',
        expected: [1, 2, 2],
      },
      {
        name: 'Math.abs',
        method: 'valueOf',
        expression: 'Math.abs(value)',
        expected: [1, 2, 2],
      },
      {
        name: 'BigInt',
        method: 'valueOf',
        expression: 'BigInt(value)',
        expected: [1n, 2n, 2],
      },
    ]

    for (const item of cases) {
      const result = compileAndRunHook<unknown[]>(
        `
          export function useRun() {
            ;(globalThis as any).__fictCoerceCount = 0
            const value = {
              ${item.method}() {
                ;(globalThis as any).__fictCoerceCount += 1
                return (globalThis as any).__fictCoerceCount
              },
            }
            const a = ${item.expression}
            const b = ${item.expression}
            return [a, b, (globalThis as any).__fictCoerceCount]
          }
        `,
        'useRun',
        { optimize: true },
      )

      expect(result, item.name).toEqual(item.expected)
    }
  })

  it('preserves arrow function self-references with optimization', () => {
    const result = compileAndRunHook<string>(
      `
        export function useRun() {
          "use pure"
          const fn = () => fn.name
          return fn()
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result).toBe('fn')
  })

  it('preserves function expression self-references with optimization', () => {
    const result = compileAndRunHook<string>(
      `
        export function useRun() {
          "use pure"
          const fn = function () {
            return fn.name
          }
          return fn()
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result).toBe('fn')
  })

  it('preserves named function expression self-references with optimization', () => {
    const result = compileAndRunHook<string>(
      `
        export function useRun() {
          "use pure"
          const fn = function inner() {
            return fn.name + ':' + inner.name
          }
          return fn()
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result).toBe('inner:inner')
  })

  it('preserves object method self-references with optimization', () => {
    const result = compileAndRunHook<string>(
      `
        export function useRun() {
          "use pure"
          const obj = {
            m() {
              return obj.m.name
            },
          }
          return obj.m()
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result).toBe('m')
  })

  it('preserves object function property and getter self-references with optimization', () => {
    const result = compileAndRunHook<boolean>(
      `
        export function useRun() {
          "use pure"
          const obj = {
            m: () => obj,
            get self() {
              return obj
            },
          }
          return obj.m() === obj && obj.self === obj
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result).toBe(true)
  })

  it('preserves invalid eager self-references with optimization', () => {
    expect(() =>
      compileAndRunHook<unknown>(
        `
          export function useRun() {
            "use pure"
            const obj = obj
            return obj
          }
        `,
        'useRun',
        { optimize: true },
      ),
    ).toThrow(ReferenceError)

    expect(() =>
      compileAndRunHook<unknown>(
        `
          export function useRun() {
            "use pure"
            const obj = (() => obj)()
            return obj
          }
        `,
        'useRun',
        { optimize: true },
      ),
    ).toThrow()
  })

  it('preserves untagged template cooked escapes with optimization', () => {
    const result = compileAndRunHook<string>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          return \`a\\nb\`
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result).toBe('a\nb')
  })

  it('preserves yield argument locals with optimization', () => {
    const result = compileAndRunHook<Generator<number, void, unknown>>(
      `
        export function* useRun() {
          const x = 1
          yield x
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result.next()).toEqual({ value: 1, done: false })
  })

  it('preserves yield delegate locals with optimization', () => {
    const result = compileAndRunHook<Generator<number, void, unknown>>(
      `
        export function* useRun() {
          const xs = [1, 2]
          yield* xs
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect([...result]).toEqual([1, 2])
  })

  it('preserves yield assignment and update writes with optimization', () => {
    const result = compileAndRunHook<Generator<number, string, unknown>>(
      `
        export function* useRun() {
          "use pure"
          let x = 1
          let y = 1
          yield (x = 2)
          yield y++
          return x + ':' + y
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result.next()).toEqual({ value: 2, done: false })
    expect(result.next()).toEqual({ value: 1, done: false })
    expect(result.next()).toEqual({ value: '2:2', done: true })
  })

  it('preserves yield member mutators with optimization', () => {
    const result = compileAndRunHook<Generator<number, number, unknown>>(
      `
        export function* useRun() {
          "use pure"
          const arr = [1]
          yield arr.push(2)
          return arr.length
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result.next()).toEqual({ value: 2, done: false })
    expect(result.next()).toEqual({ value: 2, done: true })
  })

  it('preserves class expression extends locals with optimization', () => {
    const result = compileAndRunHook<string>(
      `
        export function useRun() {
          "use pure"
          const Base = class {
            static label = 'base'
          }
          const Derived = class extends Base {}
          return Object.getPrototypeOf(Derived).label
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result).toBe('base')
  })

  it('preserves class expression computed member locals with optimization', () => {
    const result = compileAndRunHook<number>(
      `
        export function useRun() {
          "use pure"
          const key = 'm'
          const C = class {
            [key]() {
              return 2
            }
          }
          return new C().m()
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result).toBe(2)
  })

  it('preserves class expression method body locals with optimization', () => {
    const result = compileAndRunHook<number>(
      `
        export function useRun() {
          "use pure"
          const value = 6
          const C = class {
            read() {
              return value
            }
          }
          return new C().read()
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result).toBe(6)
  })

  it('preserves class expression instance field locals with optimization', () => {
    const result = compileAndRunHook<number>(
      `
        export function useRun() {
          "use pure"
          const value = 3
          const C = class {
            field = value
          }
          return new C().field
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result).toBe(3)
  })

  it('preserves class expression static field locals with optimization', () => {
    const result = compileAndRunHook<number>(
      `
        export function useRun() {
          "use pure"
          const value = 4
          const C = class {
            static field = value
          }
          return C.field
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result).toBe(4)
  })

  it('preserves class expression static block locals with optimization', () => {
    const result = compileAndRunHook<number>(
      `
        export function useRun() {
          "use pure"
          const value = 5
          let result = 0
          const Probe = class {
            static {
              result = value
            }
          }
          return result + (Probe ? 0 : 1)
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result).toBe(5)
  })

  it('preserves for-await over promise arrays with optimization', async () => {
    const result = await compileAndRunHook<Promise<number>>(
      `
        import { $state } from 'fict'

        export async function useRun() {
          let count = $state(0)
          let x = 0
          for await (const value of [Promise.resolve(1), Promise.resolve(2)]) {
            x += value
          }
          return x
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result).toBe(3)
  })

  it('preserves for-await over async generators with optimization', async () => {
    const result = await compileAndRunHook<Promise<number>>(
      `
        import { $state } from 'fict'

        async function* gen() {
          yield 1
          yield 2
        }

        export async function useRun() {
          let count = $state(0)
          let x = 0
          for await (const value of gen()) {
            x += value
          }
          return x
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result).toBe(3)
  })

  it('preserves for-await break and continue with optimization', async () => {
    const result = await compileAndRunHook<Promise<number>>(
      `
        import { $state } from 'fict'

        export async function useRun() {
          let count = $state(0)
          let x = 0
          for await (const value of [
            Promise.resolve(1),
            Promise.resolve(2),
            Promise.resolve(3),
          ]) {
            if (value === 2) {
              continue
            }
            x += value
            if (x > 2) {
              break
            }
          }
          return x
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result).toBe(4)
  })

  it('preserves for-await destructuring loop variables with optimization', async () => {
    const result = await compileAndRunHook<Promise<number>>(
      `
        import { $state } from 'fict'

        export async function useRun() {
          let count = $state(0)
          let x = 0
          for await (const [value] of [Promise.resolve([1]), Promise.resolve([2])]) {
            x += value
          }
          return x
        }
      `,
      'useRun',
      { optimize: true },
    )

    expect(result).toBe(3)
  })

  it('preserves object destructuring assignment order in reactive hooks', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          let x = 0
          ;({ a: x } = { a: 2 })
          return x
        }
      `,
      'useRun',
      { optimize: false },
    )

    expect(result).toBe(2)
  })

  it('preserves object destructuring assignment defaults in reactive hooks', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          let x = 0
          ;({ a: x = 3 } = { a: undefined })
          return x
        }
      `,
      'useRun',
      { optimize: false },
    )

    expect(result).toBe(3)
  })

  it('preserves null values in object destructuring assignment defaults', () => {
    const result = compileAndRunHook<null | number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          let x = 0
          ;({ a: x = 3 } = { a: null })
          return x
        }
      `,
      'useRun',
      { optimize: false },
    )

    expect(result).toBeNull()
  })

  it('preserves array destructuring assignment hole defaults in reactive hooks', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          let x = 0
          ;[, x = 3] = [1, undefined]
          return x
        }
      `,
      'useRun',
      { optimize: false },
    )

    expect(result).toBe(3)
  })

  it('preserves object rest destructuring assignment order in reactive hooks', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          let a = 0
          let rest = {}
          ;({ a, ...rest } = { a: 1, b: 2 })
          return rest.b
        }
      `,
      'useRun',
      { optimize: false },
    )

    expect(result).toBe(2)
  })

  it('preserves array rest destructuring assignment order in reactive hooks', () => {
    const result = compileAndRunHook<string>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          let first = 0
          let rest = []
          ;[first, ...rest] = [1, 2, 3]
          return rest.join(',')
        }
      `,
      'useRun',
      { optimize: false },
    )

    expect(result).toBe('2,3')
  })

  it('preserves immediate do-while break before trailing return', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          do {
            break
          } while (count < 3)
          return 4
        }
      `,
      'useRun',
    )

    expect(result).toBe(4)
  })

  it('preserves trailing assignments in directly emitted control-flow regions', () => {
    const result = compileAndRunHook<{ bump: () => void; view: () => number }>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let n = $state(3)
          let total = 0

          while (total < n) {
            total += 1
          }

          total = total * 2

          return {
            bump: () => {
              n = 4
            },
            view: () => total,
          }
        }
      `,
      'useRun',
    )

    expect(result.view()).toBe(6)
    result.bump()
    expect(result.view()).toBe(8)
  })

  it('preserves switch-case assignments with break before a trailing return', () => {
    const result = compileAndRunHook<{ next: () => void; view: () => string }>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let mode = $state(0)
          let label = 'A'

          switch (mode) {
            case 0:
              label = 'A'
              break
            case 1:
              label = 'B'
              break
            default:
              label = 'D'
              break
          }

          return {
            next: () => {
              mode = (mode + 1) % 3
            },
            view: () => \`\${label}-\${mode}\`,
          }
        }
      `,
      'useRun',
    )

    expect(result.view()).toBe('A-0')
    result.next()
    expect(result.view()).toBe('B-1')
    result.next()
    expect(result.view()).toBe('D-2')
    result.next()
    expect(result.view()).toBe('A-0')
  })

  it('preserves trailing statements after a matching no-default switch break', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          switch (1) {
            case 1:
              break
          }
          return 2
        }
      `,
      'useRun',
    )

    expect(result).toBe(2)
  })

  it('preserves trailing statements after a no-default switch miss', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          switch (2) {
            case 1:
              return 1
          }
          return 2
        }
      `,
      'useRun',
    )

    expect(result).toBe(2)
  })

  it('preserves trailing statements after an explicit default switch break', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          switch (2) {
            case 1:
              break
            default:
              break
          }
          return 2
        }
      `,
      'useRun',
    )

    expect(result).toBe(2)
  })

  it('preserves direct switch case returns', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          switch (1) {
            case 1:
              return 1
          }
          return 2
        }
      `,
      'useRun',
    )

    expect(result).toBe(1)
  })

  it('preserves switch case-to-case fallthrough', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          let x = 0

          switch (1) {
            case 1:
              x++
            case 2:
              x++
              break
          }

          return x
        }
      `,
      'useRun',
    )

    expect(result).toBe(2)
  })

  it('preserves switch case-to-default fallthrough', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          let x = 0

          switch (1) {
            case 1:
              x += 1
            default:
              x += 10
              break
          }

          return x
        }
      `,
      'useRun',
    )

    expect(result).toBe(11)
  })

  it('preserves switch default-in-middle fallthrough', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          let x = 0

          switch (0) {
            default:
              x++
            case 1:
              break
          }

          return x
        }
      `,
      'useRun',
    )

    expect(result).toBe(1)
  })

  it('preserves no-default switch fallthrough before a trailing return', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          let x = 0

          switch (1) {
            case 1:
              x++
            case 2:
              x++
          }

          return x
        }
      `,
      'useRun',
    )

    expect(result).toBe(2)
  })

  it('preserves labeled while-continue targets', () => {
    const result = compileAndRunHook<number | (() => number)>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let n = $state(0)
          let total = 0

          outer: while (n < 4) {
            n++
            if (n === 2) {
              continue outer
            }
            total = total + n
          }

          return total
        }
      `,
      'useRun',
    )

    const resolved = typeof result === 'function' ? result() : result
    expect(resolved).toBe(8)
  })

  it('preserves nested breaks to outer while loops before trailing returns', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          let i = 0

          outer: while (true) {
            while (true) {
              i++
              break outer
            }
          }

          return i
        }
      `,
      'useRun',
    )

    expect(result).toBe(1)
  })

  it('preserves nested breaks to outer for loops before trailing returns', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          let i = 0

          outer: for (; true;) {
            while (true) {
              i++
              break outer
            }
          }

          return i
        }
      `,
      'useRun',
    )

    expect(result).toBe(1)
  })

  it('preserves trailing reactive reads after labeled outer loop breaks', () => {
    const result = compileAndRunHook<number | (() => number)>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(3)
          let i = 0

          outer: while (true) {
            for (; true;) {
              i++
              break outer
            }
          }

          return count + i
        }
      `,
      'useRun',
    )

    const resolved = typeof result === 'function' ? result() : result
    expect(resolved).toBe(4)
  })

  it('preserves nested labeled for-of continues without corrupting fallthrough', () => {
    const result = compileAndRunHook<number | (() => number)>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let mode = $state(0)
          let total = 0

          outer: for (const row of mode === 0 ? [[1, 2], [3]] : [[1], [2, 3]]) {
            for (const cell of row) {
              if (cell === 2) {
                continue outer
              }
              total = total + cell
            }
          }

          return total
        }
      `,
      'useRun',
    )

    const resolved = typeof result === 'function' ? result() : result
    expect(resolved).toBe(4)
  })

  it('preserves labeled block breaks with trailing reactive reads', () => {
    const result = compileAndRunHook<{ toggle: () => void; view: () => string }>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let hot = $state(true)
          let label = 'cold'

          choose: {
            if (hot) {
              label = 'hot'
              break choose
            }
            label = 'warm'
          }

          return {
            toggle: () => {
              hot = !hot
            },
            view: () => label,
          }
        }
      `,
      'useRun',
    )

    expect(result.view()).toBe('hot')
    result.toggle()
    expect(result.view()).toBe('warm')
    result.toggle()
    expect(result.view()).toBe('hot')
  })

  it('preserves generic labeled blocks around nested for-of exits', () => {
    const result = compileAndRunHook<{ toggle: () => void; view: () => string }>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let hot = $state(true)
          let label = 'cold'

          choose: {
            for (const item of hot ? [1] : [2]) {
              if (item === 1) {
                label = 'hot'
                break choose
              }
            }
            label = 'warm'
          }

          return {
            toggle: () => {
              hot = !hot
            },
            view: () => label,
          }
        }
      `,
      'useRun',
    )

    expect(result.view()).toBe('hot')
    result.toggle()
    expect(result.view()).toBe('warm')
    result.toggle()
    expect(result.view()).toBe('hot')
  })

  it('preserves generic labeled blocks around nested switches', () => {
    const result = compileAndRunHook<{ toggle: () => void; view: () => string }>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let hot = $state(true)
          let label = 'cold'

          choose: {
            switch (hot ? 1 : 0) {
              case 1:
                label = 'hot'
                break choose
              default:
                label = 'warm'
                break
            }
          }

          return {
            toggle: () => {
              hot = !hot
            },
            view: () => label,
          }
        }
      `,
      'useRun',
    )

    expect(result.view()).toBe('hot')
    result.toggle()
    expect(result.view()).toBe('warm')
    result.toggle()
    expect(result.view()).toBe('hot')
  })

  it('preserves labeled switch breaks before trailing reactive returns', () => {
    const result = compileAndRunHook<{ next: () => void; view: () => string }>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let mode = $state(0)
          let label = 'A'

          choose: switch (mode) {
            case 0:
              label = 'A'
              break choose
            case 1:
              label = 'B'
              break choose
            default:
              label = 'C'
              break choose
          }

          return {
            next: () => {
              mode = (mode + 1) % 3
            },
            view: () => label,
          }
        }
      `,
      'useRun',
    )

    expect(result.view()).toBe('A')
    result.next()
    expect(result.view()).toBe('B')
    result.next()
    expect(result.view()).toBe('C')
    result.next()
    expect(result.view()).toBe('A')
  })

  it('preserves thrown try-catch side effects', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          let x = 0

          try {
            throw 0
          } catch (e) {
            x = 1
          }

          return x
        }
      `,
      'useRun',
    )

    expect(result).toBe(1)
  })

  it('preserves thrown try-catch-finally side effects', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          let x = 0

          try {
            throw 0
          } catch (e) {
            x = 1
          } finally {
            x += 2
          }

          return x
        }
      `,
      'useRun',
    )

    expect(result).toBe(3)
  })

  it('preserves try return values before mutating finally blocks', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          let x = 1

          try {
            return x
          } finally {
            x = 2
          }
        }
      `,
      'useRun',
    )

    expect(result).toBe(1)
  })

  it('lets finally returns override try returns', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)

          try {
            return 1
          } finally {
            return 2
          }
        }
      `,
      'useRun',
    )

    expect(result).toBe(2)
  })

  it('runs finally before propagating thrown try completions', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          let x = 0

          try {
            try {
              throw new Error('x')
            } finally {
              x = 2
            }
          } catch {
            return x
          }
        }
      `,
      'useRun',
    )

    expect(result).toBe(2)
  })

  it('preserves thrown expression side effects before catch', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let count = $state(0)
          let x = 0

          try {
            throw (x += 1)
          } catch (e) {
            x += e
          }

          return x
        }
      `,
      'useRun',
    )

    expect(result).toBe(2)
  })

  it('preserves labeled try-finally breaks that exit an outer label', () => {
    const result = compileAndRunHook<{ toggle: () => void; view: () => string }>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let hot = $state(true)
          let label = 'cold'

          choose: try {
            if (hot) {
              label = 'hot'
              break choose
            }
            label = 'warm'
          } finally {
            label = label + '!'
          }

          return {
            toggle: () => {
              hot = !hot
            },
            view: () => label,
          }
        }
      `,
      'useRun',
    )

    expect(result.view()).toBe('hot!')
    result.toggle()
    expect(result.view()).toBe('warm!')
    result.toggle()
    expect(result.view()).toBe('hot!')
  })

  it('preserves internal loop continues inside try-finally blocks', () => {
    const result = compileAndRunHook<{ toggle: () => void; view: () => number }>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let mode = $state(0)
          let total = 0

          try {
            for (const item of mode === 0 ? [1, 2] : [1, 2, 3]) {
              if (item === 2) {
                continue
              }
              total += item
            }
          } finally {
            total += 10
          }

          return {
            toggle: () => {
              mode = 1
            },
            view: () => total,
          }
        }
      `,
      'useRun',
    )

    expect(result.view()).toBe(11)
    result.toggle()
    expect(result.view()).toBe(14)
  })

  it('preserves for-loop breaks through try-finally blocks', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let tick = $state(0)
          let x = 0

          for (let i = 0; i < 3; i++) {
            try {
              break
            } finally {
              x = 1
            }
          }

          return x
        }
      `,
      'useRun',
    )

    expect(result).toBe(1)
  })

  it('preserves while-loop breaks through try-finally blocks', () => {
    const result = compileAndRunHook<number | (() => number)>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let tick = $state(0)
          let x = 0

          while (tick < 1) {
            try {
              break
            } finally {
              x = 1
            }
          }

          return x
        }
      `,
      'useRun',
    )

    const resolved = typeof result === 'function' ? result() : result
    expect(resolved).toBe(1)
  })

  it('preserves labeled breaks through try-finally blocks', () => {
    const result = compileAndRunHook<number>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let tick = $state(0)
          let x = 0

          outer: {
            try {
              break outer
            } finally {
              x = 1
            }
            x = 2
          }

          return x
        }
      `,
      'useRun',
    )

    expect(result).toBe(1)
  })

  it('rejects unsafe state-machine fallback for try-finally control flow', () => {
    expect(() =>
      transformCommonJS(
        `
        import { $state } from 'fict'

        export function useRun() {
          let x = $state(0)
          let step = 0

          const flag = () => {
            step += 1
            return step <= 2
          }

          while (flag()) {
            try {
              if (flag()) {
                continue
              }
            } finally {
              x = x + 1
            }

            break
          }

          return x
        }
      `,
      ),
    ).toThrow(/Unsafe state-machine fallback: Try terminator/)
  })

  it('preserves do-while continue targets inside state-machine fallback', () => {
    const result = compileAndRunHook<number | (() => number)>(
      `
        import { $state } from 'fict'

        export function useRun() {
          let i = $state(0)

          do {
            i++
            if (i === 3) {
              continue
            }
          } while (i < 5)

          return i
        }
      `,
      'useRun',
    )

    const resolved = typeof result === 'function' ? result() : result
    expect(resolved).toBe(5)
  })

  it('rejects reactive do-while state-machine fallback with stale derived locals', () => {
    expect(() =>
      compileAndRunHook(
        `
          import { $state } from 'fict'

          export function useRun() {
            let n = $state(2)
            let out = ''
            let i = 0

            do {
              out += i
              i++
              if (i === 1) {
                continue
              }
            } while (i < n)

            return {
              set: (next: number) => {
                n = next
              },
              view: () => out,
            }
          }
        `,
        'useRun',
      ),
    ).toThrow(/Unsafe reactive state-machine fallback/)
  })
})
