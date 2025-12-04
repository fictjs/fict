import { describe, it, expect } from 'vitest'

import { createEffect, createVersionedSignal } from '..'

const tick = () =>
  new Promise<void>(resolve =>
    typeof queueMicrotask === 'function'
      ? queueMicrotask(resolve)
      : Promise.resolve().then(resolve),
  )

describe('createVersionedSignal', () => {
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
})
