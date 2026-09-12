import { describe, expect, it } from 'vitest'

import { batch, createEffect } from '../src/index'
import { createStore } from '../src/store'

describe('store array partial truncation', () => {
  it.each(['set', 'defineProperty'] as const)(
    'notifies the actual mutation when Reflect.%s cannot remove a nonconfigurable index',
    operation => {
      const raw = [0, 1, 2, 3]
      Object.defineProperty(raw, '2', { configurable: false })
      const [state] = createStore(raw)
      const seen: Array<{
        length: number
        last: number | undefined
        present: boolean
        keys: string[]
      }> = []
      const stop = createEffect(() => {
        seen.push({
          length: state.length,
          last: state[3],
          present: 3 in state,
          keys: Object.keys(state),
        })
      })

      try {
        batch(() => {
          const result =
            operation === 'set'
              ? Reflect.set(state, 'length', 1)
              : Reflect.defineProperty(state, 'length', { value: 1 })
          expect(result).toBe(false)
        })
        expect(raw.length).toBe(3)
        expect(seen).toEqual([
          { length: 4, last: 3, present: true, keys: ['0', '1', '2', '3'] },
          { length: 3, last: undefined, present: false, keys: ['0', '1', '2'] },
        ])
      } finally {
        stop()
      }
    },
  )
})
