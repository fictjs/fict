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
    if (id === '@fictjs/runtime/internal') return runtime
    if (id === '@fictjs/runtime/internal/list') return {}
    if (id.startsWith('@fictjs/runtime/internal/')) {
      throw new Error(`Unexpected @fictjs/runtime internal subpath in test sandbox: ${id}`)
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

describe('state write expression semantics', () => {
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
    const raw = mod.useStateWriteExpressionSemantics() as unknown[]
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
    const raw = mod.useCompoundAssignmentSemantics() as unknown[]
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
    const raw = mod.useComputedHookMemberWrites() as unknown[]
    const values = raw.map(value =>
      typeof value === 'function' ? (value as () => unknown)() : value,
    )
    expect(values).toEqual([2, 3, 10, 3, 11])
  })
})
