import { describe, expect, it } from 'vitest'

import { batch, createRoot, onCleanup, onDestroy, onMount } from '../src/index'
import { createRenderEffect, createSignal } from '../src/advanced'
import { getCurrentRoot } from '../src/lifecycle'

describe('unobserved render effect lifetime', () => {
  it('releases a completed binding without retaining a root cleanup entry', () => {
    let runs = 0
    const owner = createRoot(() => {
      const stop = createRenderEffect(() => {
        runs++
      })
      return { stop, root: getCurrentRoot()! }
    })
    expect(runs).toBe(1)
    expect(owner.value.root.cleanups).toHaveLength(0)
    owner.value.stop()
    owner.dispose()
    expect(runs).toBe(1)
  })

  it('keeps cleanup and nested reactive children owned until disposal', () => {
    const source = createSignal(0)
    const seen: number[] = []
    const calls: string[] = []
    const owner = createRoot(() => {
      createRenderEffect(() => {
        onCleanup(() => calls.push('registered'))
        return () => calls.push('returned')
      })
      createRenderEffect(() => {
        createRenderEffect(() => {
          seen.push(source())
        })
      })
    })
    expect(calls).toEqual([])
    batch(() => source(1))
    expect(seen).toEqual([0, 1])
    owner.dispose()
    expect(calls).toEqual(['returned', 'registered'])
    batch(() => source(2))
    expect(seen).toEqual([0, 1])
  })

  it('preserves root lifecycle registered by a completed binding', () => {
    const calls: string[] = []
    const owner = createRoot(() => {
      createRenderEffect(() => {
        onMount(() => {
          calls.push('mounted')
          return () => calls.push('mount-cleanup')
        })
        onDestroy(() => calls.push('destroyed'))
      })
    })
    expect(calls).toEqual(['mounted'])
    owner.dispose()
    expect(calls).toEqual(['mounted', 'mount-cleanup', 'destroyed'])
  })
})
