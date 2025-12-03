import { describe, it, expect } from 'vitest'

import { batch, createEffect, createMemo, createSignal, onCleanup } from '..'

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

  it('runs stacked cleanups in last-in-first-out order', () => {
    const value = createSignal(0)
    const order: string[] = []

    const dispose = createEffect(() => {
      const current = value()
      onCleanup(() => order.push(`late-${current}`))
      onCleanup(() => order.push(`early-${current}`))
    })

    value(1)
    value(2)
    dispose()

    expect(order).toEqual(['early-0', 'late-0', 'early-1', 'late-1', 'early-2', 'late-2'])
  })
})
