import { describe, it, expect } from 'vitest'

import { batch, createEffect, createMemo, onCleanup, render } from '../src/index'
import { createSelector, createSignal } from '../src/advanced'

const tick = () =>
  new Promise<void>(resolve =>
    typeof queueMicrotask === 'function'
      ? queueMicrotask(resolve)
      : Promise.resolve().then(resolve),
  )

describe('signal runtime robustness', () => {
  it('coalesces batched writes across chained memos and effects', () => {
    const sourceA = createSignal(0)
    const sourceB = createSignal(0)
    const runs = { a: 0, b: 0, c: 0 }

    const a = createMemo(() => {
      runs.a++
      return sourceA() + sourceB()
    })
    const b = createMemo(() => {
      runs.b++
      return a() * 2
    })
    const c = createMemo(() => {
      runs.c++
      return b() - sourceA()
    })

    const seen: number[] = []
    createEffect(() => {
      seen.push(c())
    })

    expect(seen).toEqual([0])
    expect(runs).toEqual({ a: 1, b: 1, c: 1 })

    batch(() => {
      sourceA(1)
      sourceB(2)
      expect(seen).toEqual([0])
      sourceA(3)
      sourceB(4)
      expect(seen).toEqual([0])
    })

    expect(seen).toEqual([0, 11])
    expect(runs).toEqual({ a: 2, b: 2, c: 2 })
  })

  it('runs stacked cleanups in last-in-first-out order', async () => {
    const value = createSignal(0)
    const order: string[] = []

    const dispose = createEffect(() => {
      const current = value()
      onCleanup(() => order.push(`late-${current}`))
      onCleanup(() => order.push(`early-${current}`))
    })

    value(1)
    await tick()
    value(2)
    await tick()
    dispose()

    expect(order).toEqual(['early-0', 'late-0', 'early-1', 'late-1', 'early-2', 'late-2'])
  })

  it('keeps computed values stable during cleanup', async () => {
    const count = createSignal(0)
    const doubled = createMemo(() => count() * 2)
    const seen: number[] = []

    const dispose = createEffect(() => {
      const current = doubled()
      onCleanup(() => {
        // Cleanup should observe the previous computed value, not the new pending one.
        seen.push(doubled())
      })
      return current
    })

    count(1)
    await tick()
    count(2)
    await tick()
    dispose()

    expect(seen).toEqual([0, 2, 4])
  })

  it('handles updates triggered inside effects', async () => {
    const signal1 = createSignal(0)
    const signal2 = createSignal(0)
    const logs: string[] = []

    createEffect(() => {
      const val = signal1()
      logs.push(`effect1: ${val}`)
      if (val === 1) {
        signal2(10)
      }
    })

    createEffect(() => {
      logs.push(`effect2: ${signal2()}`)
    })

    // Initial run: both effects execute
    expect(logs).toEqual(['effect1: 0', 'effect2: 0'])

    // Update signal1 to 1
    signal1(1)

    // Before microtask: no effects have run yet
    expect(logs).toEqual(['effect1: 0', 'effect2: 0'])

    // First microtask: effect1 runs and triggers signal2 update
    await tick()
    expect(logs).toContain('effect1: 1')

    // Second microtask: effect2 runs with updated signal2 value
    await tick()
    expect(logs).toContain('effect2: 10')

    // Verify complete execution order
    expect(logs).toEqual(['effect1: 0', 'effect2: 0', 'effect1: 1', 'effect2: 10'])
  })

  it('handles mixed batch and microtask updates', async () => {
    const signal1 = createSignal(0)
    const signal2 = createSignal(0)
    let runs = 0

    createEffect(() => {
      signal1()
      signal2()
      runs++
    })

    // Initial run
    expect(runs).toBe(1)

    // Schedule microtask with signal1
    signal1(1)

    // Immediately batch signal2 (should flush synchronously)
    batch(() => {
      signal2(2)
    })

    // After batch: both signals updated, effect ran once more
    expect(runs).toBe(2)

    // Wait for microtask
    await tick()

    // Microtask should find queue empty, no additional runs
    expect(runs).toBe(2)
  })

  it('coalesces multiple synchronous updates in microtask', async () => {
    const count = createSignal(0)
    let effectRuns = 0

    createEffect(() => {
      count()
      effectRuns++
    })

    // Initial run
    expect(effectRuns).toBe(1)

    // Multiple synchronous updates
    count(1)
    count(2)
    count(3)

    // Before microtask: no new runs
    expect(effectRuns).toBe(1)

    // After microtask: only one batched run
    await tick()
    expect(effectRuns).toBe(2)
  })

  it('flushes pending updates even when batch throws', () => {
    const count = createSignal(0)
    const seen: number[] = []
    createEffect(() => {
      seen.push(count())
    })

    expect(seen).toEqual([0])

    expect(() =>
      batch(() => {
        count(1)
        throw new Error('boom')
      }),
    ).toThrow('boom')

    expect(seen).toEqual([0, 1])
  })

  it('cleans up selector effects with the owning root', async () => {
    const selected = createSignal(1)
    let select: ((key: number) => boolean) | undefined
    const container = document.createElement('div')
    document.body.appendChild(container)

    const dispose = render(() => {
      select = createSelector(() => selected())
      // Prime selector entries
      select!(1)
      select!(2)
      return document.createTextNode('')
    }, container)

    expect(select!(1)).toBe(true)
    expect(select!(2)).toBe(false)

    dispose()
    selected(2)
    await tick()

    // Selector should no longer respond after disposal
    expect(select!(1)).toBe(true)
    expect(select!(2)).toBe(false)

    container.remove()
  })
})
