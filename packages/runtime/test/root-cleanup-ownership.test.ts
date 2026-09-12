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

  it('keeps child root effects alive when their creating effect re-runs or stops', () => {
    const parentSource = createSignal(0)
    const childSource = createSignal(0)
    const seen: number[] = []
    let child: ReturnType<typeof createRoot> | undefined
    const stop = createEffect(() => {
      parentSource()
      child ??= createRoot(() => {
        createEffect(() => {
          seen.push(childSource())
        })
      })
    })
    try {
      batch(() => parentSource(1))
      batch(() => childSource(1))
      stop()
      batch(() => childSource(2))
      expect(seen).toEqual([0, 1, 2])
      child!.dispose()
      batch(() => childSource(3))
      expect(seen).toEqual([0, 1, 2])
    } finally {
      stop()
      child?.dispose()
    }
  })
})
