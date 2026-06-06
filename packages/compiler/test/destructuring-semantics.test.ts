import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'

import { transform, transformCommonJS } from './test-utils'

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
    if (id === '@fictjs/runtime/internal' || id === 'fict/internal') {
      return runtime
    }
    if (id === '@fictjs/runtime/internal/list' || id === 'fict/internal/list') return runtime
    if (id.startsWith('@fictjs/runtime/internal/') || id.startsWith('fict/internal/')) {
      throw new Error(`Unexpected internal subpath in test sandbox: ${id}`)
    }
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

const compiledFunction = (mod: Record<string, (...args: unknown[]) => unknown>, name: string) => {
  const fn = mod[name]
  if (!fn) throw new Error(`Expected compiled export ${name}`)
  return fn
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
    const paramObject = compiledFunction(mod, 'paramObject')
    expect(paramObject(undefined)).toEqual([10, 20, 30])
    expect(paramObject({})).toEqual([1, 2, 0])
    expect(paramObject({ a: 5, b: { c: 7 }, d: 9 })).toEqual([5, 7, 9])
  })

  it('preserves parameter array destructuring defaults and rest', () => {
    const source = `
      export function paramArray([first = 1, second, ...rest] = [3, 4, 5]) {
        return [first, second, rest.length]
      }
    `
    const output = transformCommonJS(source)
    const mod = runCompiled(output)
    const paramArray = compiledFunction(mod, 'paramArray')
    expect(paramArray(undefined)).toEqual([3, 4, 1])
    expect(paramArray([undefined, 2])).toEqual([1, 2, 0])
    expect(paramArray([9, 8, 7, 6])).toEqual([9, 8, 2])
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
    const nestedDecl = compiledFunction(mod, 'nestedDecl')
    expect(nestedDecl({ a: {} })).toEqual([1, 3])
    expect(nestedDecl({ a: { b: 5 }, c: 9 })).toEqual([5, 9])
    expect(nestedDecl({})).toEqual([2, 3])
  })

  it('evaluates reactive destructuring declaration defaults at declaration time', () => {
    const source = `
      import { $state } from 'fict'

      export function StateDefaultAfterMutation() {
        let count = $state(0)
        const obj = {}
        const { a = count } = obj
        count = 5
        return a
      }

      export function ReadBeforeObjectMutation() {
        let count = $state(0)
        const obj = {}
        const { a = count } = obj
        obj.a = 9
        return a
      }

      export function ArrayDefaultAfterMutation() {
        let count = $state(0)
        const arr = []
        const [a = count] = arr
        count = 5
        return a
      }
    `
    const output = transformCommonJS(source)
    const mod = runCompiled(output)

    expect(compiledFunction(mod, 'StateDefaultAfterMutation')()).toBe(0)
    expect(compiledFunction(mod, 'ReadBeforeObjectMutation')()).toBe(0)
    expect(compiledFunction(mod, 'ArrayDefaultAfterMutation')()).toBe(0)
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
    const assign = compiledFunction(mod, 'assign')
    expect(assign({ a: 1 }, [undefined])).toEqual([1, 2, 5])
    expect(assign({ a: 4, b: 6 }, [9])).toEqual([4, 6, 9])
  })

  it('preserves nested function parameter patterns and defaults', () => {
    const source = `
      export function nestedParams() {
        const pickObject = ({ a = 1, b: { c = 2 } = {}, ...rest } = { a: 10, b: { c: 20 }, d: 30 }) => [a, c, rest.d ?? 0]
        const pickArray = ([first = 1, second, ...rest] = [3, 4, 5]) => [first, second, rest.length]
        return [
          pickObject(undefined),
          pickObject({}),
          pickObject({ a: 5, b: { c: 7 }, d: 9 }),
          pickArray(undefined),
          pickArray([undefined, 2]),
          pickArray([9, 8, 7, 6]),
        ]
      }
    `
    const output = transformCommonJS(source)
    const mod = runCompiled(output)
    const nestedParams = compiledFunction(mod, 'nestedParams')
    expect(nestedParams()).toEqual([
      [10, 20, 30],
      [1, 2, 0],
      [5, 7, 9],
      [3, 4, 1],
      [1, 2, 0],
      [9, 8, 2],
    ])
  })

  it('preserves reactive scope callback parameter patterns', () => {
    const output = transform(
      `
        import { renderHook } from '@fictjs/testing-library'
        renderHook(({ value } = { value: 1 }) => value)
      `,
      { reactiveScopes: ['renderHook'] },
    )

    expect(output).toMatch(/renderHook\(\(\{\s*value\s*\}\s*=\s*\{\s*value:\s*1\s*\}\)\s*=>/)
  })
})
