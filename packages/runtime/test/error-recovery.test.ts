import { describe, expect, it } from 'vitest'

import {
  __resetReactiveState,
  batch as rawBatch,
  computed as rawComputed,
  effect as rawEffect,
  effectWithCleanup as rawEffectWithCleanup,
  signal as rawSignal,
} from '../src/signal'

const tick = () =>
  new Promise<void>(resolve =>
    typeof queueMicrotask === 'function'
      ? queueMicrotask(resolve)
      : Promise.resolve().then(resolve),
  )

describe('effect self-write convergence', () => {
  it('re-runs an effect that writes its own dependency until it converges', async () => {
    __resetReactiveState()
    const x = rawSignal(0)
    let runs = 0

    rawEffect(() => {
      runs++
      const value = x()
      if (value >= 1 && value < 5) x(value + 1)
    })

    rawBatch(() => x(1))
    for (let i = 0; i < 10; i++) await tick()

    expect(x()).toBe(5)
    expect(runs).toBeGreaterThanOrEqual(5)
  })

  it('observes a self-write made during the initial run', async () => {
    __resetReactiveState()
    const y = rawSignal(0)
    const seen: number[] = []

    rawEffect(() => {
      const value = y()
      seen.push(value)
      if (value === 0) y(1)
    })

    for (let i = 0; i < 5; i++) await tick()

    expect(seen[seen.length - 1]).toBe(1)
    expect(y()).toBe(1)
  })
})

describe('scheduler error recovery', () => {
  it('still delivers the update to sibling effects after one effect throws', async () => {
    __resetReactiveState()
    const s = rawSignal(0)
    const first: number[] = []
    const second: number[] = []

    rawEffect(() => {
      const value = s()
      first.push(value)
      if (value === 1) throw new Error('effect boom')
    })
    rawEffect(() => {
      second.push(s())
    })

    expect(first).toEqual([0])
    expect(second).toEqual([0])

    expect(() => rawBatch(() => s(1))).toThrow('effect boom')
    await tick()
    await tick()

    expect(second).toContain(1)
  })

  it('keeps the queue healthy for later writes after a mid-flush throw', async () => {
    __resetReactiveState()
    const s = rawSignal(0)
    const seen: number[] = []

    rawEffect(() => {
      const value = s()
      if (value === 1) throw new Error('effect boom')
      seen.push(value)
    })

    expect(() => rawBatch(() => s(1))).toThrow('effect boom')
    s(2)
    await tick()
    await tick()

    expect(seen).toContain(2)
  })

  it('keeps a throwing memo throwing until its dependencies change', () => {
    __resetReactiveState()
    const flag = rawSignal(false)
    const memo = rawComputed(() => {
      if (flag()) throw new Error('memo boom')
      return 1
    })

    expect(memo()).toBe(1)

    flag(true)
    expect(() => memo()).toThrow('memo boom')
    // A second read must retry and rethrow, not serve the stale pre-throw value.
    expect(() => memo()).toThrow('memo boom')

    flag(false)
    expect(memo()).toBe(1)
  })

  it('does not brick an effect whose cleanup throws', async () => {
    __resetReactiveState()
    const s = rawSignal(0)
    const runs: number[] = []
    let shouldThrow = false

    rawEffectWithCleanup(
      () => {
        runs.push(s())
      },
      () => {
        if (shouldThrow) throw new Error('cleanup boom')
      },
    )

    expect(runs).toEqual([0])

    shouldThrow = true
    expect(() => rawBatch(() => s(1))).toThrow('cleanup boom')

    shouldThrow = false
    s(2)
    await tick()
    await tick()

    expect(runs).toContain(2)
  })
})
