import { describe, expect, it } from 'vitest'

import { createEffect, createRoot, onCleanup, onDestroy, batch } from '../src/index'
import { createSignal } from '../src/advanced'

describe('cleanup dependency isolation', () => {
  it.each(['effect', 'root', 'destroy'] as const)(
    'does not subscribe the disposing effect to %s cleanup reads',
    kind => {
      const cleanupValue = createSignal(0)
      const update = createSignal(0)
      const cleanupReads: number[] = []
      const cleanup = () => {
        cleanupReads.push(cleanupValue())
      }
      const dispose =
        kind === 'effect'
          ? createEffect(() => cleanup)
          : createRoot(() => {
              if (kind === 'root') onCleanup(cleanup)
              else onDestroy(cleanup)
            }).dispose
      const seen: number[] = []
      const stop = createEffect(() => {
        seen.push(update())
        dispose()
      })

      try {
        expect(cleanupReads).toEqual([0])
        batch(() => cleanupValue(1))
        expect(seen).toEqual([0])
        batch(() => update(1))
        expect(seen).toEqual([0, 1])
      } finally {
        stop()
        dispose()
      }
    },
  )

  it('keeps effects created by cleanup independently reactive', () => {
    const source = createSignal(0)
    const seen: number[] = []
    let stop = () => {}
    const dispose = createEffect(() => () => {
      stop = createEffect(() => {
        seen.push(source())
      })
    })

    dispose()
    batch(() => source(1))
    expect(seen).toEqual([0, 1])
    stop()
  })
})
