import { describe, expect, it } from 'vitest'

import { batch, createEffect } from '../src/index'
import { createStore } from '../src/store'

describe('store property descriptor notifications', () => {
  it('invalidates descriptor readers when only descriptor flags change', () => {
    const [state] = createStore({ value: 1 })
    const seen: boolean[] = []
    const stop = createEffect(() => {
      seen.push(Object.getOwnPropertyDescriptor(state, 'value')!.writable!)
    })

    try {
      batch(() => {
        Object.defineProperty(state, 'value', { writable: false })
      })
      expect(seen).toEqual([true, false])
    } finally {
      stop()
    }
  })

  it('reflects and redefines accessors without evaluating their getters', () => {
    let reads = 0
    const first = () => {
      reads++
      throw new Error('getter must remain lazy')
    }
    const second = () => {
      reads++
      return 2
    }
    const raw = Object.defineProperty({}, 'value', {
      get: first,
      configurable: true,
      enumerable: true,
    })
    const [state] = createStore(raw)
    const seen: Array<(() => unknown) | undefined> = []
    const keys: string[][] = []
    const stop = createEffect(() => {
      seen.push(Object.getOwnPropertyDescriptor(state, 'value')?.get)
      keys.push(Object.keys(state))
    })
    try {
      batch(() => {
        Object.defineProperty(state, 'value', { get: second, enumerable: false })
      })
      expect(seen).toEqual([first, second])
      expect(keys).toEqual([['value'], []])
      expect(reads).toBe(0)
    } finally {
      stop()
    }
  })

  it('tracks adding and deleting undefined descriptors independently from value reads', () => {
    const [state] = createStore<{ value?: number | undefined }>({})
    const descriptors: boolean[] = []
    const values: Array<number | undefined> = []
    const stopDescriptor = createEffect(() => {
      descriptors.push(!!Object.getOwnPropertyDescriptor(state, 'value'))
    })
    const stopValue = createEffect(() => {
      values.push(state.value)
    })
    try {
      batch(() => {
        state.value = undefined
      })
      batch(() => {
        delete state.value
      })
      expect(descriptors).toEqual([false, true, false])
      expect(values).toEqual([undefined])
    } finally {
      stopDescriptor()
      stopValue()
    }
  })

  it('tracks descriptor values without making assignments subscribe to descriptor reads', () => {
    const [state] = createStore({ value: 0 })
    let writes = 0
    const seen: number[] = []
    const stopWriter = createEffect(() => {
      writes++
      state.value = 1
    })
    const stopReader = createEffect(() => {
      seen.push(Object.getOwnPropertyDescriptor(state, 'value')!.value)
    })
    try {
      batch(() => {
        state.value = 2
      })
      batch(() => {
        Object.defineProperty(state, 'value', { value: 2 })
      })
      expect(writes).toBe(1)
      expect(seen).toEqual([1, 2])
    } finally {
      stopWriter()
      stopReader()
    }
  })

  it.each(['set', 'defineProperty'] as const)(
    'notifies descriptors after partial array truncation via %s',
    operation => {
      const raw = [0, 1, 2, 3]
      Object.defineProperty(raw, '2', { configurable: false })
      const [state] = createStore(raw)
      const seen: Array<[number, unknown]> = []
      const stop = createEffect(() => {
        seen.push([
          Object.getOwnPropertyDescriptor(state, 'length')!.value,
          Object.getOwnPropertyDescriptor(state, '3')?.value,
        ])
      })
      try {
        batch(() => {
          const result =
            operation === 'set'
              ? Reflect.set(state, 'length', 1)
              : Reflect.defineProperty(state, 'length', { value: 1 })
          expect(result).toBe(false)
        })
        expect(seen).toEqual([
          [4, 3],
          [3, undefined],
        ])
      } finally {
        stop()
      }
    },
  )

  it('notifies the length descriptor when adding an array index', () => {
    const [state] = createStore<number[]>([])
    const seen: number[] = []
    const stop = createEffect(() => {
      seen.push(Object.getOwnPropertyDescriptor(state, 'length')!.value)
    })
    try {
      batch(() => {
        state[2] = 1
      })
      batch(() => {
        Object.defineProperty(state, '4', { value: 2 })
      })
      expect(seen).toEqual([0, 3, 5])
    } finally {
      stop()
    }
  })
})
