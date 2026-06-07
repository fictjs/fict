import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'

import { transformCommonJS } from './test-utils'

const require = createRequire(import.meta.url)

type TestSignal<T> = ((next?: T) => T | void) & { __writes: () => number }

function createRuntimeStub() {
  const createContext = () => ({ slots: [] as unknown[], cursor: 0, rendering: true })
  const createSignal = <T>(initial: T) => {
    let value = initial
    let writes = 0
    const accessor = function (this: unknown, next?: T) {
      if (arguments.length === 0) return value
      writes++
      value = next as T
      return
    } as TestSignal<T>
    accessor.__writes = () => writes
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
    createMemo: (fn: () => unknown) => (() => fn()) as () => unknown,
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
  it('preserves module-local identifier assignment side effects', () => {
    const source = `
      let value = 0

      export function set() {
        value = 1
        return value
      }

      export function get() {
        return value
      }
    `
    const output = transformCommonJS(source)
    const mod = runCompiled(output)

    expect(compiledFunction(mod, 'set')()).toBe(1)
    expect(compiledFunction(mod, 'get')()).toBe(1)
  })

  it('preserves closure-local identifier assignment side effects', () => {
    const source = `
      export function makeCounter() {
        let value = 0
        return {
          set() {
            value = 3
            return value
          },
          get() {
            return value
          },
        }
      }
    `
    const output = transformCommonJS(source)
    const mod = runCompiled(output)
    const counter = compiledFunction(mod, 'makeCounter')() as {
      set(): number
      get(): number
    }

    expect(counter.get()).toBe(0)
    expect(counter.set()).toBe(3)
    expect(counter.get()).toBe(3)
  })

  it('preserves function-valued identifier assignments', () => {
    const source = `
      export const calls: string[] = []

      let handler = () => calls.push('a')

      export function swap() {
        handler = () => calls.push('b')
      }

      export function swapAndReturn() {
        handler = () => calls.push('c')
        return handler
      }

      export function run() {
        handler()
        return calls.slice()
      }
    `
    const output = transformCommonJS(source)
    const mod = runCompiled(output)

    compiledFunction(mod, 'swap')()
    expect(compiledFunction(mod, 'run')()).toEqual(['b'])

    const returned = compiledFunction(mod, 'swapAndReturn')() as () => void
    returned()
    expect(compiledFunction(mod, 'run')()).toEqual(['b', 'c', 'c'])
  })

  it('unwraps function-valued memo optional calls', () => {
    const source = `
      import { $memo, $state } from 'fict'

      export function callOptionalMemo() {
        const fn = $memo(() => (value) => value.toUpperCase())
        const noArg = $memo(() => () => 'zero')
        const maybe = $memo(() => null)
        const direct = fn('a')
        const optional = fn?.('b')
        const optionalNoArg = noArg?.()
        const nullish = maybe?.('c')
        return [direct, optional, optionalNoArg, nullish]
      }

      export function useOptionalState() {
        const fn = $state((value) => value + '!')
        return fn?.('s')
      }

      export function callOptionalPlain() {
        const plain = (value) => value + '?'
        return plain?.('p')
      }
    `
    const output = transformCommonJS(source)
    expect(output).toContain('fn()?.("b")')
    expect(output).toContain('noArg()?.()')
    expect(output).toContain('maybe()?.("c")')
    expect(output).not.toContain('fn?.("b")')
    expect(output).not.toContain('noArg?.()')
    expect(output).not.toContain('maybe?.("c")')

    const mod = runCompiled(output)
    const raw = compiledFunction(mod, 'callOptionalMemo')() as unknown[]
    const values = raw.map(value =>
      typeof value === 'function' ? (value as () => unknown)() : value,
    )
    expect(values).toEqual(['A', 'B', 'zero', undefined])
    expect(compiledFunction(mod, 'useOptionalState')()).toBe('s!')
    expect(compiledFunction(mod, 'callOptionalPlain')()).toBe('p?')
  })

  it('keeps function entries from making container initializers lazy', () => {
    const source = `
      import { $state } from 'fict'

      export const log: string[] = []

      export function useObjectContainerTiming() {
        log.length = 0
        let count = $state(1)
        let source = 1
        const read = () => {
          log.push('object:' + source)
          return source
        }
        const out = {
          method() {
            return count
          },
          get current() {
            return count
          },
          set current(value) {
            count = value
          },
          arrow: () => count,
          fn: function() {
            return count
          },
          data: read(),
        }
        source = 2
        return [out.data, log.slice(), out.method(), out.current, out.arrow(), out.fn()]
      }

      export function useArrayContainerTiming() {
        log.length = 0
        let count = $state(1)
        let source = 1
        const read = () => {
          log.push('array:' + source)
          return source
        }
        const out = [() => count, function() { return count }, read()]
        source = 2
        return [out[2], log.slice(), out[0](), out[1]()]
      }

      export function useIifeContainerControl() {
        let count = $state(1)
        const out = { data: (() => count)() }
        return out.data
      }
    `
    const output = transformCommonJS(source)
    const mod = runCompiled(output)

    expect(compiledFunction(mod, 'useObjectContainerTiming')()).toEqual([
      1,
      ['object:1'],
      1,
      1,
      1,
      1,
    ])
    expect(compiledFunction(mod, 'useArrayContainerTiming')()).toEqual([1, ['array:1'], 1, 1])
    expect(compiledFunction(mod, 'useIifeContainerControl')()).toBe(1)
  })

  it('preserves unused identifier assignment statements', () => {
    const source = `
      let value = 0

      export function setOnly() {
        value = 5
      }

      export function get() {
        return value
      }
    `
    const output = transformCommonJS(source)
    const mod = runCompiled(output)

    compiledFunction(mod, 'setOnly')()
    expect(compiledFunction(mod, 'get')()).toBe(5)
  })

  it('keeps signal assignment controls working', () => {
    const source = `
      import { $state } from 'fict'

      export function useSignalAssignment() {
        let count = $state(0)
        count = 2
        return count
      }
    `
    const output = transformCommonJS(source)
    const mod = runCompiled(output)
    const count = compiledFunction(mod, 'useSignalAssignment')() as () => number

    expect(count()).toBe(2)
  })

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

  it('invokes function values stored in $state bindings', () => {
    const source = `
      import { $state } from 'fict'

      export function useFunctionValuedStateCall() {
        let fn = $state((value) => value + 1)
        return fn(2)
      }
    `
    const output = transformCommonJS(source)
    const mod = runCompiled(output)
    expect(compiledFunction(mod, 'useFunctionValuedStateCall')()).toBe(3)
  })

  it('preserves optional calls to function values stored in $state bindings', () => {
    const source = `
      import { $state } from 'fict'

      export function useOptionalFunctionValuedStateCall() {
        let fn = $state(() => 2)
        return fn?.()
      }
    `
    const output = transformCommonJS(source)
    const mod = runCompiled(output)
    expect(compiledFunction(mod, 'useOptionalFunctionValuedStateCall')()).toBe(2)
  })

  it('invokes function values assigned into existing $state bindings', () => {
    const source = `
      import { $state } from 'fict'

      export function useAssignedFunctionValuedStateCall() {
        let fn = $state(null)
        fn = () => 3
        return fn()
      }
    `
    const output = transformCommonJS(source)
    const mod = runCompiled(output)
    expect(compiledFunction(mod, 'useAssignedFunctionValuedStateCall')()).toBe(3)
  })

  it('keeps local function calls from inheriting callable $state metadata', () => {
    const source = `
      import { $state } from 'fict'

      export function useCallableStateShadowing() {
        let fn = $state(() => 1)
        const run = () => {
          const fn = () => 2
          return fn()
        }
        return run()
      }
    `
    const output = transformCommonJS(source)
    const mod = runCompiled(output)
    expect(compiledFunction(mod, 'useCallableStateShadowing')()).toBe(2)
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

  it('preserves declaration ordering before $state assignment statements', () => {
    const source = `
      import { $state } from 'fict'

      export function useStateAssignmentOrdering() {
        let postFlag = $state(false)
        let postCalls = 0
        postFlag = postCalls++

        let preFlag = $state(false)
        let preCalls = 0
        preFlag = ++preCalls

        let compoundFlag = $state(false)
        let compoundCalls = 0
        compoundFlag = (compoundCalls += 2)

        let pureFlag = $state(false)
        let pureCalls = 1
        pureFlag = pureCalls + 1

        let sideEffectFlag = $state(false)
        const sideEffectCalls = (() => 3)()
        sideEffectFlag = sideEffectCalls

        let noBarrierFlag = $state(false)
        noBarrierFlag = 4

        return [
          postCalls,
          postFlag,
          preCalls,
          preFlag,
          compoundCalls,
          compoundFlag,
          pureCalls,
          pureFlag,
          sideEffectCalls,
          sideEffectFlag,
          noBarrierFlag,
        ]
      }
    `
    const output = transformCommonJS(source)
    const mod = runCompiled(output)
    const raw = compiledFunction(mod, 'useStateAssignmentOrdering')() as unknown[]
    const values = raw.map(value =>
      typeof value === 'function' ? (value as () => unknown)() : value,
    )
    expect(values).toEqual([1, 0, 1, 1, 2, 2, 1, 2, 3, 3, 4])
  })

  it('preserves ToNumeric coercion for update expressions on $state', () => {
    const source = `
      import { $state } from 'fict'

      export function useUpdateCoercionSemantics() {
        let a = $state('1')
        const aPost = a++

        let b = $state(true)
        const bPre = ++b

        let c = $state(null)
        const cPost = c++

        let d = $state('')
        const dPre = ++d

        let e = $state({
          valueOf() {
            return 4
          },
        })
        const ePost = e--

        let f = $state({
          toString() {
            return '5'
          },
        })
        const fPre = --f

        let g = $state(Object(6n))
        const gPost = g++

        return [aPost, a, bPre, b, cPost, c, dPre, d, ePost, e, fPre, f, gPost, g]
      }
    `
    const output = transformCommonJS(source)
    const mod = runCompiled(output)
    const raw = compiledFunction(mod, 'useUpdateCoercionSemantics')() as unknown[]
    const values = raw.map(value =>
      typeof value === 'function' ? (value as () => unknown)() : value,
    )
    expect(values).toEqual([1, 2, 2, 2, 0, 1, 1, 1, 4, 3, 4, 4, 6n, 7n])
  })

  it('does not write $state update expressions when ToNumeric throws', () => {
    const source = `
      import { $state } from 'fict'

      export function useThrowingUpdateCoercion() {
        let value = $state(Symbol('bad'))
        return value++
      }
    `
    const output = transformCommonJS(source)
    const mod = runCompiled(output)
    expect(output).toMatch(/value\(\+\+__prev_\d+\)/)
    expect(() => compiledFunction(mod, 'useThrowingUpdateCoercion')()).toThrow(
      /Cannot convert a Symbol value/,
    )
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

  it('preserves statement-position bitwise and shift compound assignments', () => {
    const source = `
      import { $state } from 'fict'

      export function useStatementCompoundAssignmentSemantics() {
        let orValue = 1
        orValue |= 2

        let andValue = 3
        andValue &= 1

        let xorValue = 5
        xorValue ^= 3

        let shiftLeft = 1
        shiftLeft <<= 3

        let shiftRight = -8
        shiftRight >>= 1

        let shiftUnsigned = -1
        shiftUnsigned >>>= 1

        let state = $state(1)
        state |= 2
        state <<= 2
        state >>>= 1

        return [
          orValue,
          andValue,
          xorValue,
          shiftLeft,
          shiftRight,
          shiftUnsigned,
          state,
        ]
      }
    `
    const output = transformCommonJS(source)
    const mod = runCompiled(output)
    const raw = compiledFunction(mod, 'useStatementCompoundAssignmentSemantics')() as unknown[]
    const values = raw.map(value =>
      typeof value === 'function' ? (value as () => unknown)() : value,
    )
    expect(values).toEqual([3, 1, 6, 8, -4, 2147483647, 6])
  })

  it('preserves value-position bitwise and shift compound assignments', () => {
    const source = `
      export function useValueCompoundAssignmentSemantics() {
        let andValue = 7
        const andResult = (andValue &= 3)

        let orValue = 2
        const orResult = (orValue |= 1)

        let xorValue = 6
        const xorResult = (xorValue ^= 3)

        let shiftLeft = 4
        const shiftLeftResult = (shiftLeft <<= 2)

        let shiftRight = -8
        const shiftRightResult = (shiftRight >>= 1)

        let shiftUnsigned = -1
        const shiftUnsignedResult = (shiftUnsigned >>>= 1)

        let addValue = 9
        const addResult = (addValue += 4)

        return [
          andResult,
          andValue,
          orResult,
          orValue,
          xorResult,
          xorValue,
          shiftLeftResult,
          shiftLeft,
          shiftRightResult,
          shiftRight,
          shiftUnsignedResult,
          shiftUnsigned,
          addResult,
          addValue,
        ]
      }
    `
    const output = transformCommonJS(source)
    const mod = runCompiled(output)
    expect(compiledFunction(mod, 'useValueCompoundAssignmentSemantics')()).toEqual([
      3, 3, 3, 3, 5, 5, 16, 16, -4, -4, 2147483647, 2147483647, 13, 13,
    ])
  })

  it('does not reuse cached signal getter values after writes in function bodies', () => {
    const source = `
      import { $state } from 'fict'

      export function useGetterCacheAfterWrite() {
        let count = $state(1)
        const fn = () => {
          const a = count
          count = 2
          const b = count
          return a + ':' + b
        }
        return fn
      }
    `
    const output = transformCommonJS(source)
    const mod = runCompiled(output)
    const fn = compiledFunction(mod, 'useGetterCacheAfterWrite')() as () => string
    expect(fn()).toBe('1:2')
  })

  it('does not reuse cached signal getter values after writes in function expressions', () => {
    const source = `
      import { $state } from 'fict'

      export function useGetterCacheAfterFunctionExpressionWrite() {
        let count = $state(1)
        const fn = function () {
          const a = count
          count = 2
          const b = count
          return a + ':' + b
        }
        return fn
      }
    `
    const output = transformCommonJS(source)
    const mod = runCompiled(output)
    const fn = compiledFunction(mod, 'useGetterCacheAfterFunctionExpressionWrite')() as () => string
    expect(fn()).toBe('1:2')
  })

  it('does not reuse cached signal getter values after writes in expression bodies', () => {
    const source = `
      import { $state } from 'fict'

      export function useGetterCacheAfterExpressionWrite() {
        let count = $state(1)
        const fn = () => count + ':' + (count = 2) + ':' + count
        return fn
      }
    `
    const output = transformCommonJS(source)
    const mod = runCompiled(output)
    const fn = compiledFunction(mod, 'useGetterCacheAfterExpressionWrite')() as () => string
    expect(fn()).toBe('1:2:2')
  })

  it('does not reuse cached alias getter values after source signal writes', () => {
    const source = `
      import { $state } from 'fict'

      export function useGetterCacheAfterAliasSourceWrite() {
        let count = $state(1)
        const alias = count
        const fn = () => {
          const a = alias
          count = 2
          const b = alias
          return a + ':' + b
        }
        return fn
      }
    `
    const output = transformCommonJS(source)
    const mod = runCompiled(output)
    const fn = compiledFunction(mod, 'useGetterCacheAfterAliasSourceWrite')() as () => string
    expect(fn()).toBe('1:2')
  })

  it('keeps caching repeated signal getter values when the function does not write them', () => {
    const source = `
      import { $state } from 'fict'

      export function useGetterCacheWithoutWrite() {
        let count = $state(1)
        const fn = () => count + ':' + count
        return fn
      }
    `
    const output = transformCommonJS(source)
    const mod = runCompiled(output)
    const fn = compiledFunction(mod, 'useGetterCacheWithoutWrite')() as () => string
    expect(output).toMatch(/__cached_count_\d+/)
    expect(fn()).toBe('1:1')
  })

  it('does not hoist cached signal getter reads before earlier calls', () => {
    const source = `
      import { $state } from 'fict'

      export function useGetterCacheAfterEarlierCall() {
        let count = $state(1)
        const set = () => {
          count = 2
        }
        const fn = () => {
          set()
          return count + ':' + count
        }
        return fn
      }
    `
    const output = transformCommonJS(source)
    const mod = runCompiled(output)
    const fn = compiledFunction(mod, 'useGetterCacheAfterEarlierCall')() as () => string
    expect(output).not.toMatch(/const __cached_count_\d+ = count\(\)/)
    expect(fn()).toBe('2:2')
  })

  it('clears cached signal getter values across ordinary calls', () => {
    const source = `
      import { $state } from 'fict'

      export function useGetterCacheAcrossCallBarrier() {
        let count = $state(1)
        const set = () => {
          count = 2
          return 'set'
        }
        const fn = () => count + ':' + count + ':' + set() + ':' + count + ':' + count
        return fn
      }
    `
    const output = transformCommonJS(source)
    const mod = runCompiled(output)
    const fn = compiledFunction(mod, 'useGetterCacheAcrossCallBarrier')() as () => string
    expect(fn()).toBe('1:1:set:2:2')
  })

  it('does not hoist cached signal getter reads out of conditional branches', () => {
    const source = `
      import { $state } from 'fict'

      export function useGetterCacheInConditionalBranch() {
        let count = $state(1)
        const fn = (ok: boolean) => ok ? count + ':' + count : 'skip'
        return fn
      }
    `
    const output = transformCommonJS(source)
    const mod = runCompiled(output)
    const fn = compiledFunction(mod, 'useGetterCacheInConditionalBranch')() as (
      ok: boolean,
    ) => string
    expect(output).not.toMatch(/const __cached_count_\d+ = count\(\)/)
    expect(fn(false)).toBe('skip')
    expect(fn(true)).toBe('1:1')
  })

  it('does not cache signal getter reads in async arrow functions', async () => {
    const source = `
      import { $state } from 'fict'

      export function useAsyncArrowGetterCacheAfterAwait() {
        let count = $state(1)
        const set = (value: number) => {
          count = value
        }
        const fn = async () => {
          const a = count
          await 0
          const b = count
          const c = count
          return a + ':' + b + ':' + c
        }
        return [fn, set]
      }
    `
    const output = transformCommonJS(source)
    const mod = runCompiled(output)
    const [fn, set] = compiledFunction(mod, 'useAsyncArrowGetterCacheAfterAwait')() as [
      () => Promise<string>,
      (value: number) => void,
    ]
    const result = fn()
    set(2)
    expect(output).not.toContain('__cached_count_')
    await expect(result).resolves.toBe('1:2:2')
  })

  it('does not cache signal getter reads in async function expressions', async () => {
    const source = `
      import { $state } from 'fict'

      export function useAsyncFunctionGetterCacheAfterAwait() {
        let count = $state(1)
        const set = (value: number) => {
          count = value
        }
        const fn = async function () {
          const a = count
          await 0
          const b = count
          const c = count
          return a + ':' + b + ':' + c
        }
        return [fn, set]
      }
    `
    const output = transformCommonJS(source)
    const mod = runCompiled(output)
    const [fn, set] = compiledFunction(mod, 'useAsyncFunctionGetterCacheAfterAwait')() as [
      () => Promise<string>,
      (value: number) => void,
    ]
    const result = fn()
    set(2)
    expect(output).not.toContain('__cached_count_')
    await expect(result).resolves.toBe('1:2:2')
  })

  it('does not cache signal getter reads in generator function expressions', () => {
    const source = `
      import { $state } from 'fict'

      export function useGeneratorGetterCacheAfterYield() {
        let count = $state(1)
        const set = (value: number) => {
          count = value
        }
        const fn = function* () {
          const a = count
          yield 'pause'
          const b = count
          const c = count
          return a + ':' + b + ':' + c
        }
        return [fn, set]
      }
    `
    const output = transformCommonJS(source)
    const mod = runCompiled(output)
    const [fn, set] = compiledFunction(mod, 'useGeneratorGetterCacheAfterYield')() as [
      () => Generator<string, string, unknown>,
      (value: number) => void,
    ]
    const iterator = fn()
    expect(iterator.next()).toEqual({ value: 'pause', done: false })
    set(2)
    expect(output).not.toContain('__cached_count_')
    expect(iterator.next()).toEqual({ value: '1:2:2', done: true })
  })

  it('does not cache signal getter reads in generator function declarations', () => {
    const source = `
      import { $state } from 'fict'

      export function useGeneratorDeclarationGetterCacheAfterYield() {
        let count = $state(1)
        const set = (value: number) => {
          count = value
        }
        function* fn() {
          const a = count
          yield 'pause'
          const b = count
          const c = count
          return a + ':' + b + ':' + c
        }
        return [fn, set]
      }
    `
    const output = transformCommonJS(source)
    const mod = runCompiled(output)
    const [fn, set] = compiledFunction(mod, 'useGeneratorDeclarationGetterCacheAfterYield')() as [
      () => Generator<string, string, unknown>,
      (value: number) => void,
    ]
    const iterator = fn()
    expect(iterator.next()).toEqual({ value: 'pause', done: false })
    set(2)
    expect(output).not.toContain('__cached_count_')
    expect(iterator.next()).toEqual({ value: '1:2:2', done: true })
  })

  it('does not cache signal getter reads in async generator function expressions', async () => {
    const source = `
      import { $state } from 'fict'

      export function useAsyncGeneratorGetterCacheAfterYield() {
        let count = $state(1)
        const set = (value: number) => {
          count = value
        }
        const fn = async function* () {
          const a = count
          yield 'pause'
          const b = count
          const c = count
          return a + ':' + b + ':' + c
        }
        return [fn, set]
      }
    `
    const output = transformCommonJS(source)
    const mod = runCompiled(output)
    const [fn, set] = compiledFunction(mod, 'useAsyncGeneratorGetterCacheAfterYield')() as [
      () => AsyncGenerator<string, string, unknown>,
      (value: number) => void,
    ]
    const iterator = fn()
    await expect(iterator.next()).resolves.toEqual({ value: 'pause', done: false })
    set(2)
    expect(output).not.toContain('__cached_count_')
    await expect(iterator.next()).resolves.toEqual({ value: '1:2:2', done: true })
  })

  it('preserves logical assignment short-circuit semantics on ordinary locals', () => {
    const source = `
      import { $state } from 'fict'

      export function useLogicalAssignmentOrdinaryLocals() {
        let statementOr = 2
        let statementAnd = 0
        let statementNullish = 0
        let valueOr = 2
        let valueAnd = 0
        let valueNullish = 0
        let calls = 0
        const rhs = () => {
          calls++
          return 5
        }

        statementOr ||= rhs()
        statementAnd &&= rhs()
        statementNullish ??= rhs()
        const orValue = (valueOr ||= rhs())
        const andValue = (valueAnd &&= rhs())
        const nullishValue = (valueNullish ??= rhs())

        return [
          statementOr,
          statementAnd,
          statementNullish,
          valueOr,
          valueAnd,
          valueNullish,
          orValue,
          andValue,
          nullishValue,
          calls,
        ]
      }
    `
    const output = transformCommonJS(source)
    const mod = runCompiled(output)
    expect(compiledFunction(mod, 'useLogicalAssignmentOrdinaryLocals')()).toEqual([
      2, 0, 0, 2, 0, 0, 2, 0, 0, 0,
    ])
  })

  it('avoids state writes when logical assignment short-circuits', () => {
    const source = `
      import { $state } from 'fict'

      export function useLogicalAssignmentStateShortCircuit() {
        let truthy = $state(2)
        let falsy = $state(0)
        let zero = $state(0)
        let calls = 0
        const rhs = () => {
          calls++
          return 5
        }

        const orValue = (truthy ||= rhs())
        const andValue = (falsy &&= rhs())
        const nullishValue = (zero ??= rhs())
        const getCalls = () => calls

        return [orValue, andValue, nullishValue, truthy, falsy, zero, getCalls]
      }
    `
    const output = transformCommonJS(source)
    const mod = runCompiled(output)
    const raw = compiledFunction(mod, 'useLogicalAssignmentStateShortCircuit')() as [
      () => number,
      () => number,
      () => number,
      TestSignal<number>,
      TestSignal<number>,
      TestSignal<number>,
      () => number,
    ]
    const [orValue, andValue, nullishValue, truthy, falsy, zero, getCalls] = raw

    expect([orValue(), andValue(), nullishValue(), truthy(), falsy(), zero(), getCalls()]).toEqual([
      2, 0, 0, 2, 0, 0, 0,
    ])
    expect([truthy.__writes(), falsy.__writes(), zero.__writes()]).toEqual([0, 0, 0])
  })

  it('writes state once when logical assignment conditions require it', () => {
    const source = `
      import { $state } from 'fict'

      export function useLogicalAssignmentStateWrites() {
        let falsy = $state(0)
        let truthy = $state(2)
        let missing = $state(null)
        let calls = 0
        const rhs = () => {
          calls++
          return 5
        }

        const orValue = (falsy ||= rhs())
        const andValue = (truthy &&= rhs())
        const nullishValue = (missing ??= rhs())
        const getCalls = () => calls

        return [orValue, andValue, nullishValue, falsy, truthy, missing, getCalls]
      }
    `
    const output = transformCommonJS(source)
    const mod = runCompiled(output)
    const raw = compiledFunction(mod, 'useLogicalAssignmentStateWrites')() as [
      () => number,
      () => number,
      () => number,
      TestSignal<number>,
      TestSignal<number>,
      TestSignal<number | null>,
      () => number,
    ]
    const [orValue, andValue, nullishValue, falsy, truthy, missing, getCalls] = raw

    expect([
      orValue(),
      andValue(),
      nullishValue(),
      falsy(),
      truthy(),
      missing(),
      getCalls(),
    ]).toEqual([5, 5, 5, 5, 5, 5, 3])
    expect([falsy.__writes(), truthy.__writes(), missing.__writes()]).toEqual([1, 1, 1])
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

  it('does not shadow RHS locals with computed hook member key temporaries', () => {
    const source = `
      import { $state } from 'fict'

      function useBox() {
        let value = $state(0)
        const other = 5
        return { value, other }
      }

      export function useComputedHookMemberKeyCollision() {
        const box = useBox()
        const signalKey = 'value'
        const plainKey = 'other'
        const __key_0 = 10

        const signalAssigned = (box[signalKey] = __key_0 + 1)
        const plainAssigned = (box[plainKey] = __key_0 + 1)

        return [signalAssigned, plainAssigned, box.value, box.other]
      }
    `
    const output = transformCommonJS(source)
    expect(output).not.toMatch(/\(__key_0\s*=>/)

    const mod = runCompiled(output)
    const raw = compiledFunction(mod, 'useComputedHookMemberKeyCollision')() as unknown[]
    const values = raw.map(value =>
      typeof value === 'function' ? (value as () => unknown)() : value,
    )
    expect(values).toEqual([11, 11, 11, 11])
  })

  it('preserves declaration ordering before computed hook member writes', () => {
    const source = `
      import { $state } from 'fict'

      function useThing() {
        let count = $state(1)
        return { count, plain: 0 }
      }

      export function useComputedHookAssignmentOrdering() {
        const thing = useThing()
        const key = 'count'
        thing[key] = 2
        return thing.count
      }

      export function useComputedHookCompoundOrdering() {
        const thing = useThing()
        let key = 'count'
        thing[key] += 2
        return thing.count
      }

      export function useComputedHookUpdateOrdering() {
        const thing = useThing()
        var key = 'count'
        thing[key]++
        return thing.count
      }
    `
    const output = transformCommonJS(source)
    const mod = runCompiled(output)

    for (const [name, expected] of [
      ['useComputedHookAssignmentOrdering', 2],
      ['useComputedHookCompoundOrdering', 3],
      ['useComputedHookUpdateOrdering', 2],
    ] as const) {
      const raw = compiledFunction(mod, name)()
      const value = typeof raw === 'function' ? (raw as () => unknown)() : raw
      expect(value).toBe(expected)
    }
  })

  it('coerces numeric string keys for computed hook-return array writes', () => {
    const source = `
      import { $state } from 'fict'

      function usePair() {
        let count = $state(1)
        return [count]
      }

      export function useNumericStringHookArrayWrite() {
        const pair = usePair()
        const key = '0'
        const assign = (pair[key] += 2)
        const post = pair['0']++
        return [assign, post, pair[0]]
      }
    `
    const output = transformCommonJS(source)
    expect(output).toContain('pair["0"](__next_')
    expect(output).not.toContain('pair["0"] += 2')

    const mod = runCompiled(output)
    const raw = compiledFunction(mod, 'useNumericStringHookArrayWrite')() as unknown[]
    const values = raw.map(value =>
      typeof value === 'function' ? (value as () => unknown)() : value,
    )
    expect(values).toEqual([3, 3, 4])
  })

  it('coerces numeric keys for computed hook-return object writes', () => {
    const source = `
      import { $state } from 'fict'

      function useObj() {
        let count = $state(1)
        return { 0: count }
      }

      export function useNumericHookObjectWrite() {
        const obj = useObj()
        const key = 0
        const assign = (obj[key] += 2)
        const post = obj[0]++
        return [assign, post, obj['0']]
      }
    `
    const output = transformCommonJS(source)
    expect(output).toContain('obj[0](__next_')
    expect(output).not.toContain('obj[0] += 2')

    const mod = runCompiled(output)
    const raw = compiledFunction(mod, 'useNumericHookObjectWrite')() as unknown[]
    const values = raw.map(value =>
      typeof value === 'function' ? (value as () => unknown)() : value,
    )
    expect(values).toEqual([3, 3, 4])
  })

  it('keeps non-canonical numeric strings on the computed hook fallback path', () => {
    const source = `
      import { $state } from 'fict'

      function useObj() {
        let count = $state(1)
        return { 0: count, other: 10 }
      }

      export function useNonCanonicalHookKeyWrite() {
        const obj = useObj()
        const key = '00'
        const assigned = (obj[key] = 5)
        return [assigned, obj[0], obj['00']]
      }
    `
    const output = transformCommonJS(source)
    expect(output).not.toMatch(/__key_\d+ === 00/)

    const mod = runCompiled(output)
    const raw = compiledFunction(mod, 'useNonCanonicalHookKeyWrite')() as unknown[]
    const values = raw.map(value =>
      typeof value === 'function' ? (value as () => unknown)() : value,
    )
    expect(values).toEqual([5, 1, 5])
  })

  it('coerces numeric string keys for hook-return array reads', () => {
    const source = `
      import { $state } from 'fict'

      function usePair() {
        let count = $state(1)
        return [count]
      }

      export function useNumericStringHookArrayRead() {
        const pair = usePair()
        return [pair[0], pair['0'], pair['00']]
      }
    `
    const output = transformCommonJS(source)
    expect(output).toContain('pair["0"]()')
    expect(output).toContain('pair[0]()')
    expect(output).toContain('pair["00"]')
    expect(output).not.toContain('pair["00"]()')

    const mod = runCompiled(output)
    const raw = compiledFunction(mod, 'useNumericStringHookArrayRead')() as unknown[]
    expect(raw).toEqual([1, 1, undefined])
  })

  it('coerces numeric keys for hook-return object reads', () => {
    const source = `
      import { $state } from 'fict'

      function useObj() {
        let count = $state(1)
        return { 0: count }
      }

      export function useNumericHookObjectRead() {
        const obj = useObj()
        return [obj[0], obj['0']]
      }
    `
    const output = transformCommonJS(source)
    expect(output).toContain('obj[0]()')
    expect(output).toContain('obj["0"]()')

    const mod = runCompiled(output)
    const raw = compiledFunction(mod, 'useNumericHookObjectRead')() as unknown[]
    expect(raw).toEqual([1, 1])
  })

  it('coerces BigInt literal keys for hook-return reads', () => {
    const source = `
      import { $state } from 'fict'

      function usePair() {
        let count = $state(1)
        let doubled = $state(2)
        return [count, doubled]
      }

      function useObj() {
        let count = $state(3)
        let doubled = $state(4)
        return { 0: count, 1: doubled }
      }

      function useComputedObj() {
        let count = $state(5)
        return { [0n]: count }
      }

      export function useBigIntHookMemberRead() {
        const pair = usePair()
        const obj = useObj()
        const computedObj = useComputedObj()
        return [pair[0n], pair[1n], obj[0n], obj[1n], computedObj[0n], pair[-1n]]
      }
    `
    const output = transformCommonJS(source)
    expect(output).toContain('pair[0n]()')
    expect(output).toContain('pair[1n]()')
    expect(output).toContain('obj[0n]()')
    expect(output).toContain('obj[1n]()')
    expect(output).toContain('computedObj[0n]()')
    expect(output).not.toContain('pair[-1n]()')

    const mod = runCompiled(output)
    const raw = compiledFunction(mod, 'useBigIntHookMemberRead')() as unknown[]
    expect(raw).toEqual([1, 2, 3, 4, 5, undefined])
  })

  it('coerces BigInt keys for computed hook-return writes and updates', () => {
    const source = `
      import { $state } from 'fict'

      function usePair() {
        let count = $state(1)
        let doubled = $state(10)
        return [count, doubled]
      }

      function useObj() {
        let count = $state(20)
        let doubled = $state(30)
        return { 0: count, 1: doubled }
      }

      export function useBigIntHookMemberWrite() {
        const pair = usePair()
        const obj = useObj()
        const zero = 0n
        const one = 1n
        const assign = (pair[zero] += 2)
        const post = pair[one]++
        const objAssign = (obj[zero] = 40)
        const objPost = obj[one]++
        return [assign, post, pair[0], pair[1], objAssign, objPost, obj[0], obj[1]]
      }
    `
    const output = transformCommonJS(source)
    expect(output).not.toMatch(/__key_\d+ === 0/)
    expect(output).not.toMatch(/__key_\d+ === 1/)
    expect(output).toMatch(/__propertyKey_\d+ === "0"/)
    expect(output).toMatch(/__propertyKey_\d+ === "1"/)

    const mod = runCompiled(output)
    const raw = compiledFunction(mod, 'useBigIntHookMemberWrite')() as unknown[]
    const values = raw.map(value =>
      typeof value === 'function' ? (value as () => unknown)() : value,
    )
    expect(values).toEqual([3, 10, 3, 11, 40, 30, 40, 31])
  })

  it('keeps negative BigInt hook-return keys on the computed fallback path', () => {
    const source = `
      import { $state } from 'fict'

      function usePair() {
        let count = $state(1)
        return [count]
      }

      export function useNegativeBigIntHookKeyWrite() {
        const pair = usePair()
        const key = -1n
        const assigned = (pair[key] = 5)
        return [assigned, pair[0], pair[-1n]]
      }
    `
    const output = transformCommonJS(source)
    expect(output).toMatch(/__propertyKey_\d+ === "0"/)
    expect(output).not.toContain('pair[-1n]()')

    const mod = runCompiled(output)
    const raw = compiledFunction(mod, 'useNegativeBigIntHookKeyWrite')() as unknown[]
    const values = raw.map(value =>
      typeof value === 'function' ? (value as () => unknown)() : value,
    )
    expect(values).toEqual([5, 1, 5])
  })

  it('coerces signed static keys for hook-return reads', () => {
    const source = `
      import { $state } from 'fict'

      function useBucket() {
        let neg = $state(1)
        let one = $state(2)
        return { "-1": neg, "1": one }
      }

      function useComputedBucket() {
        let neg = $state(3)
        return { [-1]: neg }
      }

      function readDynamic(bucket, key) {
        return typeof bucket[key]
      }

      export function useSignedHookMemberRead() {
        const bucket = useBucket()
        const computed = useComputedBucket()
        return [bucket[-1], bucket[-1n], bucket[+"1"], computed[-1], readDynamic(bucket, -1)]
      }
    `
    const output = transformCommonJS(source)
    expect(output).toContain('bucket[-1]()')
    expect(output).toContain('bucket[-1n]()')
    expect(output).toContain('bucket[+"1"]()')
    expect(output).toContain('computed[-1]()')
    expect(output).not.toContain('bucket[key]()')

    const mod = runCompiled(output)
    const raw = compiledFunction(mod, 'useSignedHookMemberRead')() as unknown[]
    expect(raw).toEqual([1, 1, 2, 3, 'function'])
  })

  it('coerces signed static keys for hook-return writes and updates', () => {
    const source = `
      import { $state } from 'fict'

      function useBucket() {
        let neg = $state(1)
        let one = $state(10)
        return { "-1": neg, "1": one }
      }

      export function useSignedHookMemberWrite() {
        const bucket = useBucket()
        const assign = (bucket[-1] = 5)
        const post = bucket[-1n]++
        const plus = (bucket[+"1"] += 2)
        return [assign, post, plus, bucket["-1"], bucket["1"]]
      }
    `
    const output = transformCommonJS(source)
    expect(output).toContain('bucket[-1](__next_')
    expect(output).not.toContain('bucket[-1] = 5')
    expect(output).toContain('bucket[-1n]()')
    expect(output).toContain('bucket[-1n](__prev_')
    expect(output).toContain('bucket[+"1"](__next_')

    const mod = runCompiled(output)
    const raw = compiledFunction(mod, 'useSignedHookMemberWrite')() as unknown[]
    const values = raw.map(value =>
      typeof value === 'function' ? (value as () => unknown)() : value,
    )
    expect(values).toEqual([5, 5, 12, 6, 12])
  })

  it('records static computed hook-return object keys', () => {
    const source = `
      import { $state } from 'fict'

      function useObj() {
        let count = $state(1)
        let other = $state(2)
        return { other, ['count']: count, [0]: count }
      }

      export function useStaticComputedHookObjectKeys() {
        const obj = useObj()
        return [obj.count, obj.other, obj[0], obj['0']]
      }
    `
    const output = transformCommonJS(source)
    expect(output).toContain('obj.count()')
    expect(output).toContain('obj.other()')
    expect(output).toContain('obj[0]()')
    expect(output).toContain('obj["0"]()')

    const mod = runCompiled(output)
    const raw = compiledFunction(mod, 'useStaticComputedHookObjectKeys')() as unknown[]
    expect(raw).toEqual([1, 2, 1, 1])
  })

  it('keeps dynamic computed hook-return object keys conservative', () => {
    const source = `
      import { $state } from 'fict'

      function useObj(key) {
        let count = $state(1)
        let other = $state(2)
        return { other, [key]: count }
      }

      export function useDynamicComputedHookObjectKey() {
        const obj = useObj('count')
        return [typeof obj.count, obj.other]
      }
    `
    const output = transformCommonJS(source)
    expect(output).not.toContain('obj.count()')
    expect(output).toContain('obj.other()')

    const mod = runCompiled(output)
    const raw = compiledFunction(mod, 'useDynamicComputedHookObjectKey')() as unknown[]
    expect(raw).toEqual(['function', 2])
  })

  it('invalidates hook-return object metadata before later spreads', () => {
    const source = `
      import { $state } from 'fict'

      function useObj() {
        let count = $state(1)
        const override = { count: 9 }
        return { count, ...override }
      }

      export function useSpreadOverrideHookObject() {
        const obj = useObj()
        return obj.count
      }
    `
    const output = transformCommonJS(source)
    expect(output).not.toContain('obj.count()')

    const mod = runCompiled(output)
    const raw = compiledFunction(mod, 'useSpreadOverrideHookObject')()
    expect(raw).toBe(9)
  })

  it('preserves hook-return object metadata for props after spreads', () => {
    const source = `
      import { $state } from 'fict'

      function useObj() {
        let count = $state(1)
        let other = $state(2)
        const override = { count: 9, other: 8 }
        return { count, ...override, other }
      }

      export function usePostSpreadHookObjectProp() {
        const obj = useObj()
        return [obj.count, obj.other]
      }
    `
    const output = transformCommonJS(source)
    expect(output).not.toContain('obj.count()')
    expect(output).toContain('obj.other()')

    const mod = runCompiled(output)
    const raw = compiledFunction(mod, 'usePostSpreadHookObjectProp')() as unknown[]
    expect(raw).toEqual([9, 2])
  })

  it('invalidates hook-return metadata for later duplicate plain props', () => {
    const source = `
      import { $state } from 'fict'

      function useObj() {
        let count = $state(1)
        return { count, count: 9, ['other']: count, ['other']: 8 }
      }

      export function useDuplicatePlainHookProps() {
        const obj = useObj()
        return [obj.count, obj.other]
      }
    `
    const output = transformCommonJS(source)
    expect(output).not.toContain('obj.count()')
    expect(output).not.toContain('obj.other()')

    const mod = runCompiled(output)
    const raw = compiledFunction(mod, 'useDuplicatePlainHookProps')() as unknown[]
    expect(raw).toEqual([9, 8])
  })

  it('preserves hook-return metadata for later duplicate accessor props', () => {
    const source = `
      import { $state } from 'fict'

      function useObj() {
        let count = $state(1)
        let other = $state(2)
        return { count: 9, count, ['other']: 8, ['other']: other }
      }

      export function useDuplicateAccessorHookProps() {
        const obj = useObj()
        return [obj.count, obj.other]
      }
    `
    const output = transformCommonJS(source)
    expect(output).toContain('obj.count()')
    expect(output).toContain('obj.other()')

    const mod = runCompiled(output)
    const raw = compiledFunction(mod, 'useDuplicateAccessorHookProps')() as unknown[]
    expect(raw).toEqual([1, 2])
  })

  it('applies duplicate hook-return metadata rules to numeric keys', () => {
    const source = `
      import { $state } from 'fict'

      function usePlainLast() {
        let count = $state(1)
        return { [0]: count, 0: 9 }
      }

      function useAccessorLast() {
        let count = $state(1)
        return { 0: 9, [0]: count }
      }

      export function useDuplicateNumericHookProps() {
        const plainLast = usePlainLast()
        const accessorLast = useAccessorLast()
        return [plainLast[0], accessorLast[0]]
      }
    `
    const output = transformCommonJS(source)
    expect(output).not.toContain('plainLast[0]()')
    expect(output).toContain('accessorLast[0]()')

    const mod = runCompiled(output)
    const raw = compiledFunction(mod, 'useDuplicateNumericHookProps')() as unknown[]
    expect(raw).toEqual([9, 1])
  })

  it('stops hook-return array metadata after spreads', () => {
    const source = `
      import { $state } from 'fict'

      function useArr() {
        let count = $state(1)
        const prefix = [9, 8]
        return [...prefix, count]
      }

      export function usePostSpreadHookArray() {
        const arr = useArr()
        return [arr[1], typeof arr[2]]
      }
    `
    const output = transformCommonJS(source)
    expect(output).not.toContain('arr[1]()')
    expect(output).not.toContain('arr[2]()')

    const mod = runCompiled(output)
    const raw = compiledFunction(mod, 'usePostSpreadHookArray')() as unknown[]
    expect(raw).toEqual([8, 'function'])
  })

  it('preserves hook-return array metadata before spreads', () => {
    const source = `
      import { $state } from 'fict'

      function useArr() {
        let count = $state(1)
        const suffix = [9, 8]
        return [count, ...suffix]
      }

      export function usePreSpreadHookArray() {
        const arr = useArr()
        return [arr[0], arr[1]]
      }
    `
    const output = transformCommonJS(source)
    expect(output).toContain('arr[0]()')
    expect(output).not.toContain('arr[1]()')

    const mod = runCompiled(output)
    const raw = compiledFunction(mod, 'usePreSpreadHookArray')() as unknown[]
    expect(raw).toEqual([1, 9])
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
