import { describe, expect, it } from 'vitest'

import { batch, createEffect } from '../src/index'
import { createStore } from '../src/store'

describe('store accessor notifications', () => {
  it('tracks the resulting accessor value across repeated setter inputs', () => {
    let value = 0
    let reads = 0
    const [state] = createStore({
      get total() {
        reads++
        return value
      },
      set total(increment: number) {
        value += increment
      },
    })
    const seen: number[] = []
    const stop = createEffect(() => {
      seen.push(state.total)
    })

    try {
      batch(() => {
        state.total = 1
        expect(reads).toBe(1)
      })
      batch(() => {
        state.total = 1
        expect(reads).toBe(2)
      })
      expect(value).toBe(2)
      expect(seen).toEqual([0, 1, 2])
    } finally {
      stop()
    }
  })

  it('invalidates inherited setters whose output differs from their input', () => {
    let value = 0
    const raw = Object.create({
      get total() {
        return value
      },
      set total(next: number) {
        value = next * 2
      },
    }) as { total: number }
    const [state] = createStore(raw)
    const seen: number[] = []
    const stop = createEffect(() => {
      seen.push(state.total)
    })
    try {
      batch(() => {
        state.total = 1
      })
      batch(() => {
        state.total = 2
      })
      expect(seen).toEqual([0, 2, 4])
    } finally {
      stop()
    }
  })
})
