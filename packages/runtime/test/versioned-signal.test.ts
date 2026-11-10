import { describe, it, expect } from 'vitest'

import { createEffect, batch } from '../src/index'
import { createVersionedSignal, createSignal } from '../src/advanced'

const tick = () =>
  new Promise<void>(resolve =>
    typeof queueMicrotask === 'function'
      ? queueMicrotask(resolve)
      : Promise.resolve().then(resolve),
  )

describe('createVersionedSignal', () => {
  it.each(['write', 'force'] as const)('does not subscribe a writer through %s', mode => {
    const source = createSignal(0)
    const value = createVersionedSignal(0)
    let runs = 0
    const stop = createEffect(() => {
      const next = source()
      // Bound the original regression so this test cannot hang the process.
      if (++runs > 20) return
      if (mode === 'write') value.write(next)
      else value.force()
    })
    try {
      batch(() => source(1))
      expect(runs).toBe(2)
      batch(() => value.write(2))
      batch(() => value.force())
      expect(runs).toBe(2)
    } finally {
      stop()
    }
  })

  it('notifies readers when writing identical values', async () => {
    const counter = createVersionedSignal(0)
    const observed: number[] = []

    createEffect(() => {
      observed.push(counter.read())
    })

    expect(observed).toEqual([0])

    counter.write(0)
    await tick()
    expect(observed).toEqual([0, 0])

    counter.write(1)
    await tick()
    expect(observed).toEqual([0, 0, 1])
  })

  it('force method bumps version without changing value', async () => {
    const counter = createVersionedSignal(5)
    let runs = 0

    createEffect(() => {
      counter.read()
      runs++
    })

    expect(runs).toBe(1)
    counter.force()
    await tick()
    expect(runs).toBe(2)
    expect(counter.peekValue()).toBe(5)
  })

  it('peekValue does not track dependencies', async () => {
    const counter = createVersionedSignal(10)
    let runs = 0

    createEffect(() => {
      // Use peekValue - should NOT track
      counter.peekValue()
      runs++
    })

    expect(runs).toBe(1)

    // Writing should NOT cause effect to re-run since peekValue doesn't track
    counter.write(20)
    await tick()
    expect(runs).toBe(1)
    expect(counter.peekValue()).toBe(20)
  })

  it('peekVersion does not track dependencies', async () => {
    const counter = createVersionedSignal(0)
    let runs = 0

    createEffect(() => {
      // Use peekVersion - should NOT track
      counter.peekVersion()
      runs++
    })

    expect(runs).toBe(1)

    // Force should NOT cause effect to re-run since peekVersion doesn't track
    counter.force()
    await tick()
    expect(runs).toBe(1)
    expect(counter.peekVersion()).toBe(1)
  })
})
