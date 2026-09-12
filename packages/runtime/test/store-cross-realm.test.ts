import { runInNewContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

import { batch, createEffect, createRoot } from '../src/index'
import { createStore } from '../src/internal'

describe('store values from another realm', () => {
  it.each([false, true])('preserves boxed primitive values (foreign: %s)', foreign => {
    const values: object[] = foreign
      ? runInNewContext(
          '[Object(1), Object("text"), Object(true), Object(2n), Object(Symbol.for("boxed"))]',
        )
      : [Object(1), Object('text'), Object(true), Object(2n), Object(Symbol.for('boxed'))]
    const [state] = createStore({ values })
    expect(state.values.map(value => value.valueOf())).toEqual([
      1,
      'text',
      true,
      2n,
      Symbol.for('boxed'),
    ])
  })

  it('tracks a foreign Map without changing its method receiver', () => {
    const map = runInNewContext('new Map([["key", 1]])') as Map<string, number>
    const [state] = createStore({ map })
    const values: Array<number | undefined> = []
    const owner = createRoot(() => {
      createEffect(() => {
        values.push(state.map.get('key'))
      })
    })
    try {
      batch(() => state.map.set('key', 2))
      expect(state.map.size).toBe(1)
      expect(values).toEqual([1, 2])
    } finally {
      owner.dispose()
    }
  })

  it('tracks foreign Set, WeakMap, and WeakSet mutations', () => {
    const foreign = runInNewContext(
      '({ set: new Set(), map: new WeakMap(), weak: new WeakSet() })',
    ) as {
      set: Set<object>
      map: WeakMap<object, number>
      weak: WeakSet<object>
    }
    const [state] = createStore(foreign)
    const key = {}
    const values: unknown[][] = []
    const owner = createRoot(() => {
      createEffect(() => {
        values.push([state.set.has(key), state.map.get(key), state.weak.has(key)])
      })
    })
    try {
      batch(() => {
        state.set.add(key)
        state.map.set(key, 1)
        state.weak.add(key)
      })
      expect(values).toEqual([
        [false, undefined, false],
        [true, 1, true],
      ])
    } finally {
      owner.dispose()
    }
  })

  it('preserves foreign built-ins whose methods require internal slots', async () => {
    const foreign = runInNewContext(
      '({ date: new Date(123), regexp: /abc/, promise: Promise.resolve(5), buffer: new ArrayBuffer(4) })',
    ) as {
      date: Date
      regexp: RegExp
      promise: Promise<number>
      buffer: ArrayBuffer
    }
    const [state] = createStore(foreign)
    expect(state.date.getTime()).toBe(123)
    expect(state.regexp.test('abc')).toBe(true)
    expect(await state.promise).toBe(5)
    expect(state.buffer.byteLength).toBe(4)
    expect(state.buffer.slice(0).byteLength).toBe(4)
  })

  it('continues tracking foreign plain objects, arrays, and user class instances', () => {
    const foreign = runInNewContext(
      '({ plain: { value: 1 }, array: [1], instance: new (class Counter { value = 1 })() })',
    ) as {
      plain: { value: number }
      array: number[]
      instance: { value: number }
    }
    const [state] = createStore(foreign)
    const values: number[][] = []
    const owner = createRoot(() => {
      createEffect(() => {
        values.push([state.plain.value, state.array[0]!, state.instance.value])
      })
    })
    try {
      batch(() => {
        state.plain.value = 2
        state.array[0] = 2
        state.instance.value = 2
      })
      expect(values).toEqual([
        [1, 1, 1],
        [2, 2, 2],
      ])
    } finally {
      owner.dispose()
    }
  })

  it('does not classify user objects by invoking constructor or tag getters', () => {
    class Counter {
      value = 1
    }
    Object.defineProperty(Counter.prototype, 'constructor', {
      get() {
        throw new Error('constructor getter must not run')
      },
    })
    Object.defineProperty(Counter.prototype, Symbol.toStringTag, {
      get() {
        throw new Error('tag getter must not run')
      },
    })
    const [state] = createStore({ counter: new Counter() })
    expect(state.counter.value).toBe(1)
    state.counter.value = 2
    expect(state.counter.value).toBe(2)
  })

  it('keeps objects with a spoofed built-in tag deeply reactive', () => {
    const [state] = createStore({ fake: { [Symbol.toStringTag]: 'Map', value: 1 } })
    const values: number[] = []
    const owner = createRoot(() => {
      createEffect(() => {
        values.push(state.fake.value)
      })
    })
    try {
      batch(() => {
        state.fake.value = 2
      })
      expect(values).toEqual([1, 2])
    } finally {
      owner.dispose()
    }
  })
})
