import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'

import { transformCommonJS } from './test-utils'

const require = createRequire(import.meta.url)

const createRuntimeStub = () => {
  const createContext = () => ({ slots: [] as unknown[], cursor: 0, rendering: true })
  const createSignal = <T>(initial: T) => {
    let value = initial
    const accessor = function (this: unknown, next?: T) {
      if (arguments.length === 0) return value
      value = next as T
      return value
    } as (next?: T) => T
    return accessor
  }
  const createMemo = <T>(fn: () => T) => {
    return (() => fn()) as () => T
  }
  const createEffect = (fn: () => void) => {
    fn()
  }

  return {
    createSignal,
    createMemo,
    createEffect,
    __fictUseContext: () => createContext(),
    __fictUseSignal: (_ctx: ReturnType<typeof createContext>, initial: unknown) => {
      const index = _ctx.cursor++
      if (!_ctx.slots[index]) {
        _ctx.slots[index] = createSignal(initial)
      }
      return _ctx.slots[index] as (next?: unknown) => unknown
    },
    __fictUseMemo: (_ctx: ReturnType<typeof createContext>, fn: () => unknown) => {
      const index = _ctx.cursor++
      if (!_ctx.slots[index]) {
        _ctx.slots[index] = createMemo(fn)
      }
      return _ctx.slots[index] as () => unknown
    },
    __fictUseEffect: (_ctx: ReturnType<typeof createContext>, fn: () => void) => {
      const index = _ctx.cursor++
      if (!_ctx.slots[index]) {
        _ctx.slots[index] = true
        createEffect(fn)
      }
    },
    __fictRender: (_ctx: ReturnType<typeof createContext>, fn: () => unknown) => {
      _ctx.cursor = 0
      _ctx.rendering = true
      return fn()
    },
    __fictPushContext: () => createContext(),
    __fictPopContext: () => {},
  }
}

const runCompiled = (code: string) => {
  const runtime = createRuntimeStub()
  const module = { exports: {} as Record<string, unknown> }
  const sandboxRequire = (id: string) => {
    if (id === '@fictjs/runtime/internal') return runtime
    return require(id)
  }
  const sandbox = {
    module,
    exports: module.exports,
    require: sandboxRequire,
    console,
    __filename: 'compiled.cjs',
    __dirname: '.',
  }

  runInNewContext(code, sandbox, { filename: 'compiled.cjs' })
  return module.exports
}

describe('optimizer differential behavior', () => {
  it('produces equivalent results with optimize on/off for reactive functions', () => {
    const cases = [
      {
        name: 'const-fold',
        exportName: 'ComponentConst',
        source: `
          import { $state } from 'fict'
          export function ComponentConst() {
            let count = $state(2)
            const __a = 1 + 2
            const __b = __a + 3
            const doubled = count * 2
            return __b + doubled
          }
        `,
      },
      {
        name: 'stable-member',
        exportName: 'ComponentSymbol',
        source: `
          import { $state } from 'fict'
          export function ComponentSymbol() {
            let count = $state(1)
            const __a = Symbol.iterator
            const __b = Symbol.iterator
            return __a === __b ? count : 0
          }
        `,
      },
      {
        name: 'cse-math',
        exportName: 'ComponentMath',
        source: `
          import { $state } from 'fict'
          export function ComponentMath() {
            let count = $state(1)
            const __a = Math.PI
            const __b = Math.PI
            const __c = __b + 1
            return __c + count
          }
        `,
      },
      {
        name: 'inline-const',
        exportName: 'ComponentInline',
        source: `
          import { $state } from 'fict'
          export function ComponentInline() {
            let count = $state(2)
            const __tmp = 4
            const __res = __tmp + 5
            return __res + count
          }
        `,
      },
    ]

    for (const testCase of cases) {
      const optimized = transformCommonJS(testCase.source, {
        fineGrainedDom: false,
        optimize: true,
        dev: false,
      })
      const unoptimized = transformCommonJS(testCase.source, {
        fineGrainedDom: false,
        optimize: false,
        dev: false,
      })

      const optimizedModule = runCompiled(optimized)
      const unoptimizedModule = runCompiled(unoptimized)

      const optimizedRun = optimizedModule[testCase.exportName] as () => unknown
      const unoptimizedRun = unoptimizedModule[testCase.exportName] as () => unknown

      expect(optimizedRun(), testCase.name).toBe(unoptimizedRun())
    }
  })
})
