import { describe, expect, it } from 'vitest'

import {
  __resetReactiveState,
  batch as rawBatch,
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
