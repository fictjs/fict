import { describe, expect, it } from 'vitest'

import { batch, createEffect, createRoot, onCleanup, untrack } from '../src/index'
import { createSignal } from '../src/advanced'

describe('cleanup ownership across explicit roots', () => {
  it('keeps a child root cleanup alive when the creating effect re-runs', () => {
    const source = createSignal(0)
    let cleanups = 0
    let child: ReturnType<typeof createRoot> | undefined
    const stop = createEffect(() => {
      source()
      child ??= createRoot(() => {
        onCleanup(() => {
          cleanups++
        })
      })
    })

    try {
      batch(() => source(1))
      expect(cleanups).toBe(0)
      child!.dispose()
      expect(cleanups).toBe(1)
    } finally {
      stop()
      child?.dispose()
    }
    expect(cleanups).toBe(1)
  })

  it('keeps same-root cleanup registered inside untrack owned by its effect', () => {
    const source = createSignal(0)
    let cleanups = 0
    const stop = createEffect(() => {
      source()
      untrack(() => {
        onCleanup(() => {
          cleanups++
        })
      })
    })

    batch(() => source(1))
    expect(cleanups).toBe(1)
    stop()
    expect(cleanups).toBe(2)
  })
})
