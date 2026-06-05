import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import * as runtimeInternal from '../../runtime/src/internal'

import { transformCommonJS } from './test-utils'

function compileAndRunHook<T>(
  source: string,
  exportName: string,
  options: Parameters<typeof transformCommonJS>[1] = {},
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

  return runtimeInternal.__fictRender({ slots: [], cursor: 0 }, () => (hook as () => T)())
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
})
