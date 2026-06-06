import { describe, expect, it } from 'vitest'

import { createEffect } from '../src/index'
import { createStore } from '../src/internal'
import { createDiffingSignal } from '../src/store'

const tick = () => Promise.resolve()

describe('createStore iteration tracking', () => {
  it('allocates property signals only when reads are tracked', async () => {
    const originalHook = (globalThis as { __FICT_DEVTOOLS_HOOK__?: unknown }).__FICT_DEVTOOLS_HOOK__
    const signalRegisters: number[] = []
    ;(
      globalThis as {
        __FICT_DEVTOOLS_HOOK__?: {
          registerSignal: (id: number) => void
          updateSignal: (id: number, value: unknown) => void
          registerComputed: (id: number, value: unknown) => void
          updateComputed: (id: number, value: unknown) => void
          registerEffect: (id: number) => void
          effectRun: (id: number, duration?: number) => void
        }
      }
    ).__FICT_DEVTOOLS_HOOK__ = {
      registerSignal: (id: number) => {
        signalRegisters.push(id)
      },
      updateSignal: (_id: number, _value: unknown) => {},
      registerComputed: (_id: number, _value: unknown) => {},
      updateComputed: (_id: number, _value: unknown) => {},
      registerEffect: (_id: number) => {},
      effectRun: (_id: number, _duration?: number) => {},
    }

    try {
      const [state] = createStore({ foo: 1 })

      // Non-reactive reads should not allocate signal nodes.
      state.foo
      expect(signalRegisters).toHaveLength(0)

      createEffect(() => {
        state.foo
      })

      await tick()
      expect(signalRegisters).toHaveLength(1)
    } finally {
      ;(globalThis as { __FICT_DEVTOOLS_HOOK__?: unknown }).__FICT_DEVTOOLS_HOOK__ = originalHook
    }
  })

  it('tracks ownKeys/for-in when keys change', async () => {
    const [state, setState] = createStore<{ foo?: string; bar?: string }>({ foo: 'a' })
    const seen: string[][] = []

    createEffect(() => {
      seen.push(Object.keys(state))
    })

    await tick()
    expect(seen[seen.length - 1]).toEqual(['foo'])

    setState(s => {
      ;(s as any).bar = 'b'
    })
    await tick()
    expect(seen[seen.length - 1]).toContain('bar')

    setState(s => {
      delete (s as any).foo
    })
    await tick()
    expect(seen[seen.length - 1]).toEqual(['bar'])
  })

  it('tracks ownKeys when key set changes but length stays the same', async () => {
    const [state, setState] = createStore<{ foo?: string; bar?: string }>({ foo: 'a' })
    const seen: string[][] = []

    createEffect(() => {
      seen.push(Object.keys(state))
    })

    await tick()
    expect(seen[seen.length - 1]).toEqual(['foo'])

    setState(s => {
      delete (s as any).foo
      ;(s as any).bar = 'b'
    })
    await tick()

    expect(seen[seen.length - 1]).toEqual(['bar'])
  })
})

describe('createStore descriptor safety', () => {
  it('returns descriptor-defined read-only nested objects without wrapping', () => {
    const child = { value: 1 }
    const raw: { child?: { value: number } } = {}
    Object.defineProperty(raw, 'child', {
      value: child,
      enumerable: true,
      configurable: false,
      writable: false,
    })

    const [state] = createStore(raw as { child: { value: number } })

    expect(state.child).toBe(child)
    expect(state.child.value).toBe(1)
  })

  it('reacts when Object.defineProperty adds internal store properties', async () => {
    const [state] = createStore<{ value?: number }>({})
    const seen: Array<number | undefined> = []

    createEffect(() => {
      seen.push(state.value)
    })

    await tick()
    expect(seen).toEqual([undefined])

    Object.defineProperty(state, 'value', {
      value: 1,
      enumerable: true,
      configurable: true,
      writable: true,
    })
    await tick()

    expect(seen).toEqual([undefined, 1])
  })

  it('reacts when Object.defineProperty redefines internal store values', async () => {
    const [state] = createStore({ value: 1 })
    const seen: number[] = []

    createEffect(() => {
      seen.push(state.value)
    })

    await tick()
    Object.defineProperty(state, 'value', {
      value: 2,
      enumerable: true,
      configurable: true,
      writable: true,
    })
    await tick()

    expect(seen).toEqual([1, 2])
  })

  it('assigns internal store setters without reading throwing getters first', () => {
    const calls: number[] = []
    const raw: { value?: number } = {}
    Object.defineProperty(raw, 'value', {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error('getter should not run')
      },
      set(next: number) {
        calls.push(next)
      },
    })
    const [state] = createStore(raw)

    expect(() => {
      state.value = 1
    }).not.toThrow()
    expect(calls).toEqual([1])
  })

  it('throws for same-value writes to read-only internal store data properties', () => {
    const raw: { value?: number } = {}
    Object.defineProperty(raw, 'value', {
      value: 1,
      enumerable: true,
      configurable: true,
      writable: false,
    })
    const [state] = createStore(raw)

    expect(() => {
      state.value = 1
    }).toThrow(TypeError)
  })

  it('does not notify after failed internal Object.defineProperty mutations', async () => {
    const raw = Object.preventExtensions({}) as { value?: number }
    const [state] = createStore(raw)
    const values: Array<number | undefined> = []
    const keys: string[] = []

    createEffect(() => {
      values.push(state.value)
    })
    createEffect(() => {
      keys.push(Object.keys(state).join(','))
    })

    await tick()
    expect(() => {
      Object.defineProperty(state, 'value', {
        value: 1,
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }).toThrow(TypeError)
    await tick()

    expect(values).toEqual([undefined])
    expect(keys).toEqual([''])
  })

  it('keeps mutable nested internal store objects reactive', async () => {
    const raw = { child: { value: 1 } }
    const [state] = createStore(raw)
    const seen: number[] = []

    expect(state.child).not.toBe(raw.child)

    createEffect(() => {
      seen.push(state.child.value)
    })

    await tick()
    state.child.value = 2
    await tick()

    expect(seen).toEqual([1, 2])
  })
})

describe('createStore reconciliation', () => {
  it('reacts when array length is truncated via direct assignment', async () => {
    const [state, setState] = createStore<{ items: number[] }>({ items: [1, 2, 3] })
    const seen: Array<number | undefined> = []

    createEffect(() => {
      seen.push(state.items[2])
    })

    await tick()
    expect(seen[seen.length - 1]).toBe(3)

    setState(s => {
      s.items.length = 1
    })
    await tick()

    expect(state.items.length).toBe(1)
    expect(seen[seen.length - 1]).toBe(undefined)
  })

  it('handles array shrink when reconciling', async () => {
    const [state, setState] = createStore<{ items: number[] }>({ items: [1, 2, 3, 4, 5] })
    const seen: number[][] = []

    createEffect(() => {
      seen.push([...state.items])
    })

    await tick()
    expect(seen[seen.length - 1]).toEqual([1, 2, 3, 4, 5])

    // Shrink the array
    setState(() => ({ items: [1, 2] }))
    await tick()
    expect(seen[seen.length - 1]).toEqual([1, 2])
    expect(state.items.length).toBe(2)
  })

  it('handles array expand when reconciling', async () => {
    const [state, setState] = createStore<{ items: number[] }>({ items: [1, 2] })
    const seen: number[][] = []

    createEffect(() => {
      seen.push([...state.items])
    })

    await tick()
    expect(seen[seen.length - 1]).toEqual([1, 2])

    // Expand the array
    setState(() => ({ items: [1, 2, 3, 4, 5] }))
    await tick()
    expect(seen[seen.length - 1]).toEqual([1, 2, 3, 4, 5])
    expect(state.items.length).toBe(5)
  })

  it('handles array element updates during reconciliation', async () => {
    const [state, setState] = createStore<{ items: number[] }>({ items: [1, 2, 3] })
    const seen: number[][] = []

    createEffect(() => {
      seen.push([...state.items])
    })

    await tick()
    expect(seen[seen.length - 1]).toEqual([1, 2, 3])

    // Update middle element
    setState(() => ({ items: [1, 99, 3] }))
    await tick()
    expect(seen[seen.length - 1]).toEqual([1, 99, 3])
  })

  it('allows replacing nested objects with primitives', async () => {
    const [state, setState] = createStore<{ value: { nested: number } | number }>({
      value: { nested: 42 },
    })
    let observedValue: any

    createEffect(() => {
      observedValue = state.value
    })

    await tick()
    expect((observedValue as any).nested).toBe(42)

    // Replace nested object with primitive value
    setState(() => ({ value: 100 }))
    await tick()
    expect(state.value).toBe(100)
  })

  it('throws when replacing store with primitive', () => {
    const [, setState] = createStore<{ value: number }>({ value: 1 })

    expect(() => setState(() => 1 as any)).toThrow(
      '[Fict] Cannot replace store with primitive value',
    )
  })

  it('preserves explicit undefined keys during reconciliation', async () => {
    const [state, setState] = createStore<{ foo?: number }>({ foo: 1 })
    const hasFooSnapshots: boolean[] = []

    createEffect(() => {
      hasFooSnapshots.push('foo' in state)
      state.foo
    })

    await tick()
    expect(hasFooSnapshots[hasFooSnapshots.length - 1]).toBe(true)

    setState(() => ({ foo: undefined }))
    await tick()

    expect('foo' in state).toBe(true)
    expect(Object.keys(state)).toEqual(['foo'])
    expect(state.foo).toBeUndefined()
    expect(hasFooSnapshots[hasFooSnapshots.length - 1]).toBe(true)
  })

  it('reconciles enumerable symbol keys', async () => {
    const sym = Symbol('value')
    const [state, setState] = createStore<Record<string | symbol, unknown>>({
      [sym]: 1,
      a: 1,
    })
    const seen: unknown[] = []

    createEffect(() => {
      seen.push(state[sym])
    })

    await tick()
    expect(seen[seen.length - 1]).toBe(1)

    setState(() => ({ [sym]: 2, a: 2 }))
    await tick()

    expect(state[sym]).toBe(2)
    expect(seen[seen.length - 1]).toBe(2)
    expect(Reflect.ownKeys(state)).toEqual(['a', sym])

    setState(() => ({ a: 3 }))
    await tick()

    expect(sym in state).toBe(false)
    expect(state[sym]).toBeUndefined()
    expect(seen[seen.length - 1]).toBeUndefined()
  })

  it('reconciles nested enumerable symbol keys', async () => {
    const sym = Symbol('nested')
    const [state, setState] = createStore<{ box: Record<string | symbol, unknown> }>({
      box: { [sym]: 1, label: 'a' },
    })

    setState(() => ({ box: { [sym]: 2, label: 'a' } }))
    await tick()

    expect(state.box[sym]).toBe(2)
    expect(Reflect.ownKeys(state.box)).toEqual(['label', sym])
  })

  it('does not retrigger nested subscribers for structurally equal object updates', async () => {
    const [state, setState] = createStore<{ user: { name: string; profile: { age: number } } }>({
      user: { name: 'Ada', profile: { age: 30 } },
    })
    let runs = 0

    createEffect(() => {
      state.user.profile.age
      runs += 1
    })

    await tick()
    expect(runs).toBe(1)

    setState(() => ({ user: { name: 'Ada', profile: { age: 30 } } }))
    await tick()
    expect(runs).toBe(1)
  })

  it('keeps nested subscriptions precise during object reconciliation', async () => {
    const [state, setState] = createStore<{ user: { name: string; profile: { age: number } } }>({
      user: { name: 'Ada', profile: { age: 30 } },
    })
    let nameRuns = 0
    let ageRuns = 0

    createEffect(() => {
      state.user.name
      nameRuns += 1
    })
    createEffect(() => {
      state.user.profile.age
      ageRuns += 1
    })

    await tick()
    expect(nameRuns).toBe(1)
    expect(ageRuns).toBe(1)

    setState(() => ({ user: { name: 'Grace', profile: { age: 30 } } }))
    await tick()
    expect(nameRuns).toBe(2)
    expect(ageRuns).toBe(1)
  })
})

describe('createDiffingSignal reactivity', () => {
  it('tracks key iteration updates', async () => {
    const [read, write] = createDiffingSignal<{ foo?: number; bar?: number }>({ foo: 1 })
    const seen: string[][] = []

    createEffect(() => {
      seen.push(Object.keys(read()))
    })

    await tick()
    expect(seen[seen.length - 1]).toEqual(['foo'])

    write({ foo: 1, bar: 2 })
    await tick()
    expect(seen[seen.length - 1]).toContain('bar')
  })

  it('tracks key iteration updates when key set changes with same length', async () => {
    const [read, write] = createDiffingSignal<{ foo?: number; bar?: number }>({ foo: 1 })
    const seen: string[][] = []

    createEffect(() => {
      seen.push(Object.keys(read()))
    })

    await tick()
    expect(seen[seen.length - 1]).toEqual(['foo'])

    write({ bar: 2 })
    await tick()
    expect(seen[seen.length - 1]).toEqual(['bar'])
  })

  it('tracks "in" checks for key presence', async () => {
    const [read, write] = createDiffingSignal<{ foo?: number; bar?: number }>({ foo: 1 })
    const seen: boolean[] = []

    createEffect(() => {
      seen.push('bar' in read())
    })

    await tick()
    expect(seen[seen.length - 1]).toBe(false)

    write({ foo: 1, bar: 2 })
    await tick()
    expect(seen[seen.length - 1]).toBe(true)
  })

  it('tracks "in" checks when undefined keys are added or removed', async () => {
    const [read, write] = createDiffingSignal<{ x?: undefined }>({})
    const seen: boolean[] = []

    createEffect(() => {
      seen.push('x' in read())
    })

    await tick()
    expect(seen).toEqual([false])

    write({ x: undefined })
    await tick()
    expect(seen).toEqual([false, true])

    write({})
    await tick()
    expect(seen).toEqual([false, true, false])
  })

  it('tracks descriptor checks when undefined keys are added or removed', async () => {
    const [read, write] = createDiffingSignal<{ x?: undefined }>({ x: undefined })
    const seen: boolean[] = []

    createEffect(() => {
      seen.push(Boolean(Object.getOwnPropertyDescriptor(read(), 'x')))
    })

    await tick()
    expect(seen).toEqual([true])

    write({})
    await tick()
    expect(seen).toEqual([true, false])

    write({ x: undefined })
    await tick()
    expect(seen).toEqual([true, false, true])
  })

  it('tracks Object.hasOwn checks when undefined keys are added or removed', async () => {
    const [read, write] = createDiffingSignal<{ x?: undefined }>({})
    const seen: boolean[] = []

    createEffect(() => {
      seen.push(Object.hasOwn(read(), 'x'))
    })

    await tick()
    expect(seen).toEqual([false])

    write({ x: undefined })
    await tick()
    expect(seen).toEqual([false, true])

    write({})
    await tick()
    expect(seen).toEqual([false, true, false])
  })

  it('notifies iterate subscribers for same-reference writes', async () => {
    const value: { foo?: number; bar?: number } = { foo: 1 }
    const [read, write] = createDiffingSignal(value)
    const seen: string[][] = []

    createEffect(() => {
      seen.push(Object.keys(read()))
    })

    await tick()
    expect(seen[seen.length - 1]).toEqual(['foo'])

    delete value.foo
    value.bar = 2
    write(value)
    await tick()

    expect(seen[seen.length - 1]).toEqual(['bar'])
  })

  it('notifies presence subscribers for same-reference writes', async () => {
    const value: { x?: undefined } = {}
    const [read, write] = createDiffingSignal(value)
    const inSeen: boolean[] = []
    const descriptorSeen: boolean[] = []

    createEffect(() => {
      inSeen.push('x' in read())
    })
    createEffect(() => {
      descriptorSeen.push(Boolean(Object.getOwnPropertyDescriptor(read(), 'x')))
    })

    await tick()
    expect(inSeen).toEqual([false])
    expect(descriptorSeen).toEqual([false])

    value.x = undefined
    write(value)
    await tick()
    expect(inSeen).toEqual([false, true])
    expect(descriptorSeen).toEqual([false, true])

    delete value.x
    write(value)
    await tick()
    expect(inSeen).toEqual([false, true, false])
    expect(descriptorSeen).toEqual([false, true, false])
  })

  it('tracks ownKeys order changes for same-reference writes', async () => {
    const value: { a?: number; b?: number } = { a: 1, b: 2 }
    const [read, write] = createDiffingSignal(value)
    const seen: string[][] = []

    createEffect(() => {
      seen.push(Object.keys(read()))
    })

    await tick()
    expect(seen[seen.length - 1]).toEqual(['a', 'b'])

    delete value.a
    value.a = 1
    write(value)
    await tick()

    expect(seen[seen.length - 1]).toEqual(['b', 'a'])
  })

  it('tracks ownKeys order changes for new references with same key set', async () => {
    const [read, write] = createDiffingSignal<{ a: number; b: number }>({ a: 1, b: 2 })
    const seen: string[][] = []

    createEffect(() => {
      seen.push(Object.keys(read()))
    })

    await tick()
    expect(seen[seen.length - 1]).toEqual(['a', 'b'])

    write({ b: 2, a: 1 })
    await tick()

    expect(seen[seen.length - 1]).toEqual(['b', 'a'])
  })

  it('normalizes non-configurable descriptors to satisfy proxy invariants', () => {
    const source = {} as Record<string, number>
    Object.defineProperty(source, 'locked', {
      value: 1,
      enumerable: true,
      configurable: false,
      writable: false,
    })
    const [read] = createDiffingSignal(source)

    expect(() => Object.getOwnPropertyDescriptor(read(), 'locked')).not.toThrow()
    const descriptor = Object.getOwnPropertyDescriptor(read(), 'locked')
    expect(descriptor?.configurable).toBe(true)
    expect(descriptor?.enumerable).toBe(true)
    expect(descriptor?.value).toBe(1)
  })

  it('throws on direct proxy writes in dev mode', () => {
    const [read] = createDiffingSignal<{ foo?: number }>({ foo: 1 })
    expect(() => {
      ;(read() as any).foo = 2
    }).toThrow('[Fict] Cannot set "foo" on a diffing signal proxy directly.')
  })
})
