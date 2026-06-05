import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'

import { transformCommonJS } from './test-utils'

const require = createRequire(import.meta.url)

function createRuntimeStub() {
  const createContext = () => ({ slots: [] as unknown[], cursor: 0, rendering: true })
  const createSignal = <T>(initial: T) => {
    let value = initial
    const accessor = function (this: unknown, next?: T) {
      if (arguments.length === 0) return value
      value = next as T
      return
    } as (next?: T) => T | void
    return accessor
  }

  return {
    __fictUseContext: () => createContext(),
    __fictUseSignal: (ctx: ReturnType<typeof createContext>, initial: unknown) => {
      const index = ctx.cursor++
      if (!ctx.slots[index]) {
        ctx.slots[index] = createSignal(initial)
      }
      return ctx.slots[index] as (next?: unknown) => unknown
    },
    __fictUseMemo: (ctx: ReturnType<typeof createContext>, fn: () => unknown) => {
      const index = ctx.cursor++
      if (!ctx.slots[index]) {
        ctx.slots[index] = (() => fn()) as () => unknown
      }
      return ctx.slots[index] as () => unknown
    },
    __fictUseEffect: () => {
      throw new Error('__fictUseEffect should not be called in this test')
    },
  }
}

function runCompiled(code: string): Record<string, (...args: unknown[]) => unknown> {
  const runtime = createRuntimeStub()
  const module = { exports: {} as Record<string, unknown> }
  const sandboxRequire = (id: string) => {
    if (id === '@fictjs/runtime/internal' || id === 'fict/internal') return runtime
    if (id === '@fictjs/runtime/internal/list' || id === 'fict/internal/list') return {}
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

function compiledFunction(
  mod: Record<string, (...args: unknown[]) => unknown>,
  name: string,
): (...args: unknown[]) => unknown {
  const fn = mod[name]
  if (!fn) throw new Error(`Expected compiled export ${name}`)
  return fn
}

describe('state write expression semantics', () => {
  it('preserves non-strict member assignment semantics on $state objects', () => {
    const source = `
      import { $state } from 'fict'

      export function useStateObjectMemberAssignment() {
        let user = $state({ name: 'A' })
        user.name = 'B'
        return user
      }
    `
    const output = transformCommonJS(source)
    expect(output).toContain('user().name = "B"')
    const mod = runCompiled(output)
    const user = compiledFunction(mod, 'useStateObjectMemberAssignment')() as () => {
      name: string
    }
    expect(user()).toEqual({ name: 'B' })
  })

  it('preserves non-strict member update semantics on $state objects', () => {
    const source = `
      import { $state } from 'fict'

      export function useStateObjectMemberUpdate() {
        let user = $state({ count: 1 })
        const post = user.count++
        return [post, user]
      }
    `
    const output = transformCommonJS(source)
    expect(output).toContain('user().count++')
    const mod = runCompiled(output)
    const [post, user] = compiledFunction(mod, 'useStateObjectMemberUpdate')() as [
      number | (() => number),
      () => { count: number },
    ]
    expect(typeof post === 'function' ? post() : post).toBe(1)
    expect(user()).toEqual({ count: 2 })
  })

  it('preserves non-strict length assignment semantics on $state arrays', () => {
    const source = `
      import { $state } from 'fict'

      export function useStateArrayLengthAssignment() {
        let items = $state([1, 2, 3])
        items.length = 1
        return items
      }
    `
    const output = transformCommonJS(source)
    expect(output).toContain('items().length = 1')
    const mod = runCompiled(output)
    const items = compiledFunction(mod, 'useStateArrayLengthAssignment')() as () => number[]
    expect(items()).toEqual([1])
  })

  it('preserves non-strict index assignment semantics on $state arrays', () => {
    const source = `
      import { $state } from 'fict'

      export function useStateArrayIndexAssignment() {
        let items = $state([1, 2, 3])
        items[1] = 9
        return items
      }
    `
    const output = transformCommonJS(source)
    expect(output).toContain('items()[1] = 9')
    const mod = runCompiled(output)
    const items = compiledFunction(mod, 'useStateArrayIndexAssignment')() as () => number[]
    expect(items()).toEqual([1, 9, 3])
  })

  it('preserves for-of assignment semantics on $state bindings', () => {
    const source = `
      import { $state } from 'fict'

      export function useForOfStateAssignment() {
        let item = $state(0)
        for (item of [1, 2]) {}
        return item
      }
    `
    const output = transformCommonJS(source)
    const mod = runCompiled(output)
    const item = compiledFunction(mod, 'useForOfStateAssignment')() as () => number
    expect(item()).toBe(2)
  })

  it('preserves for-in assignment semantics on $state bindings', () => {
    const source = `
      import { $state } from 'fict'

      export function useForInStateAssignment() {
        let key = $state('')
        for (key in { a: 1, b: 2 }) {}
        return key
      }
    `
    const output = transformCommonJS(source)
    const mod = runCompiled(output)
    const key = compiledFunction(mod, 'useForInStateAssignment')() as () => string
    expect(key()).toBe('b')
  })

  it('preserves JS return values for update/assignment expressions on $state', () => {
    const source = `
      import { $state } from 'fict'

      export function useStateWriteExpressionSemantics() {
        let count = $state(1)
        const post = count++
        const pre = ++count
        const assign = (count = 5)
        const compound = (count += 2)
        return [post, pre, assign, compound, count]
      }
    `
    const output = transformCommonJS(source)
    const mod = runCompiled(output)
    const raw = compiledFunction(mod, 'useStateWriteExpressionSemantics')() as unknown[]
    const values = raw.map(value =>
      typeof value === 'function' ? (value as () => unknown)() : value,
    )
    expect(values).toEqual([1, 3, 5, 7, 7])
  })

  it('preserves full compound/logical assignment semantics on $state', () => {
    const source = `
      import { $state } from 'fict'

      export function useCompoundAssignmentSemantics() {
        let count = $state(10)
        const mod = (count %= 4)
        const pow = (count **= 3)
        const andKeep = (count &&= 0)
        const orSet = (count ||= 5)
        const nullishKeep = (count ??= 9)
        const bit = (count |= 2)
        return [mod, pow, andKeep, orSet, nullishKeep, bit, count]
      }
    `
    const output = transformCommonJS(source)
    const mod = runCompiled(output)
    const raw = compiledFunction(mod, 'useCompoundAssignmentSemantics')() as unknown[]
    const values = raw.map(value =>
      typeof value === 'function' ? (value as () => unknown)() : value,
    )
    expect(values).toEqual([2, 8, 0, 5, 5, 7, 7])
  })

  it('evaluates computed hook member assignment targets exactly once', () => {
    const source = `
      import { $state } from 'fict'

      function useBucket() {
        let left = $state(1)
        let right = $state(10)
        return { left, right }
      }

      export function useComputedHookMemberWrites() {
        const bucket = useBucket()
        const keys = ['left', 'right', 'left', 'right']
        let probe = 0

        const assign = (bucket[keys[probe++]] += 2)
        const post = bucket[keys[probe++]]++

        return [probe, assign, post, bucket.left, bucket.right]
      }
    `
    const output = transformCommonJS(source)
    const mod = runCompiled(output)
    const raw = compiledFunction(mod, 'useComputedHookMemberWrites')() as unknown[]
    const values = raw.map(value =>
      typeof value === 'function' ? (value as () => unknown)() : value,
    )
    expect(values).toEqual([2, 3, 10, 3, 11])
  })

  it('preserves bigint update semantics for $state', () => {
    const source = `
      import { $state } from 'fict'

      export function useBigIntUpdateSemantics() {
        let count = $state(1n)
        const post = count++
        const pre = ++count
        return [post, pre, count]
      }
    `
    const output = transformCommonJS(source)
    const mod = runCompiled(output)
    const raw = compiledFunction(mod, 'useBigIntUpdateSemantics')() as unknown[]
    const values = raw.map(value =>
      typeof value === 'function' ? (value as () => unknown)() : value,
    )
    expect(values).toEqual([1n, 3n, 3n])
  })
})
