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
  return module.exports as Record<string, (...args: unknown[]) => unknown>
}

describe('destructuring semantic alignment', () => {
  it('preserves parameter object destructuring defaults and rest', () => {
    const source = `
      export function paramObject({ a = 1, b: { c = 2 } = {}, ...rest } = { a: 10, b: { c: 20 }, d: 30 }) {
        return [a, c, rest.d ?? 0]
      }
    `
    const output = transformCommonJS(source)
    const mod = runCompiled(output)
    expect(mod.paramObject(undefined)).toEqual([10, 20, 30])
    expect(mod.paramObject({})).toEqual([1, 2, 0])
    expect(mod.paramObject({ a: 5, b: { c: 7 }, d: 9 })).toEqual([5, 7, 9])
  })

  it('preserves parameter array destructuring defaults and rest', () => {
    const source = `
      export function paramArray([first = 1, second, ...rest] = [3, 4, 5]) {
        return [first, second, rest.length]
      }
    `
    const output = transformCommonJS(source)
    const mod = runCompiled(output)
    expect(mod.paramArray(undefined)).toEqual([3, 4, 1])
    expect(mod.paramArray([undefined, 2])).toEqual([1, 2, 0])
    expect(mod.paramArray([9, 8, 7, 6])).toEqual([9, 8, 2])
  })

  it('preserves nested destructuring in variable declarations', () => {
    const source = `
      export function nestedDecl(obj) {
        const { a: { b = 1 } = { b: 2 }, c = 3 } = obj
        return [b, c]
      }
    `
    const output = transformCommonJS(source)
    const mod = runCompiled(output)
    expect(mod.nestedDecl({ a: {} })).toEqual([1, 3])
    expect(mod.nestedDecl({ a: { b: 5 }, c: 9 })).toEqual([5, 9])
    expect(mod.nestedDecl({})).toEqual([2, 3])
  })

  it('preserves defaults in destructuring assignments', () => {
    const source = `
      export function assign(obj, arr) {
        let a, b, c
        ;({ a, b = 2 } = obj)
        ;[c = 5] = arr
        return [a, b, c]
      }
    `
    const output = transformCommonJS(source)
    const mod = runCompiled(output)
    expect(mod.assign({ a: 1 }, [undefined])).toEqual([1, 2, 5])
    expect(mod.assign({ a: 4, b: 6 }, [9])).toEqual([4, 6, 9])
  })
})
