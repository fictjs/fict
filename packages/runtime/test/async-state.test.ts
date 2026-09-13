import { afterEach, describe, expect, it } from 'vitest'

import { AsyncDisposedError, AsyncEmptyError, AsyncState, isAsyncPending } from '../src/async-state'
import { createMemo } from '../src/memo'
import { __resetReactiveState, effect, flush, signal } from '../src/signal'

afterEach(__resetReactiveState)

const thrown = (fn: () => unknown): unknown => {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error('Expected a throwing read')
}

describe('async readiness contract', () => {
  it('distinguishes current, stale, absent, undefined, and rejected values', async () => {
    const state = new AsyncState<undefined>()
    expect(state.snapshot.status).toBe('uninitialized')
    const initial = state.begin()
    expect(thrown(() => state.read())).toBe(initial)
    expect(thrown(() => state.latest())).toBe(initial)
    expect(state.publish(initial.generation, undefined)).toBe(true)
    await initial
    expect(state.snapshot).toMatchObject({ status: 'ready', hasValue: true, value: undefined })
    expect(state.read()).toBeUndefined()

    const refresh = state.begin()
    expect(state.snapshot.status).toBe('refreshing')
    expect(thrown(() => state.read())).toBe(refresh)
    expect(state.latest()).toBeUndefined()
    state.reject(refresh.generation, undefined)
    await refresh
    expect(state.snapshot.status).toBe('errored')
    expect(thrown(() => state.read())).toBeUndefined()
    expect(state.latest()).toBeUndefined()

    const recovery = state.begin()
    state.publish(recovery.generation, undefined)
    expect(state.read()).toBeUndefined()
  })

  it('releases superseded waiters and rejects every late settlement', async () => {
    const state = new AsyncState<string>()
    const first = state.begin()
    const second = state.begin()
    await first
    expect(thrown(() => state.read())).toBe(second)
    expect(state.publish(first.generation, 'stale')).toBe(false)
    expect(state.reject(first.generation, new Error('stale'))).toBe(false)
    expect(state.complete(first.generation)).toBe(false)
    expect(state.snapshot.status).toBe('pending')
    state.publish(second.generation, 'current')
    await second
    expect(state.publish(second.generation, 'duplicate')).toBe(false)
    expect(state.reject(second.generation, 'duplicate')).toBe(false)
    expect(state.read()).toBe('current')
  })

  it.each([
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ])('only the newest generation wins settlement order %j', (...order: number[]) => {
    const state = new AsyncState<number>()
    const tokens = [state.begin(), state.begin(), state.begin()]
    for (const index of order) {
      state.publish(tokens[index]!.generation, index)
      state.reject(tokens[index]!.generation, 'duplicate rejection')
    }
    expect(state.read()).toBe(2)
  })

  it('streams successive current values and settles readiness at the first yield', async () => {
    const state = new AsyncState<number>()
    const token = state.begin()
    state.publish(token.generation, 1, false)
    await token
    expect(state.read()).toBe(1)
    state.publish(token.generation, 2, false)
    expect(state.read()).toBe(2)
    const beforeCompletion = state.snapshot
    expect(state.complete(token.generation)).toBe(true)
    expect(state.snapshot).toBe(beforeCompletion)
    expect(state.publish(token.generation, 3, false)).toBe(false)
  })

  it('does not mistake an empty refreshed stream for a successful current value', () => {
    const state = new AsyncState<number>()
    const empty = state.begin()
    state.complete(empty.generation)
    expect(thrown(() => state.read())).toBeInstanceOf(AsyncEmptyError)
    const value = state.begin()
    state.publish(value.generation, 7)
    const refresh = state.begin()
    state.complete(refresh.generation)
    expect(thrown(() => state.read())).toBeInstanceOf(AsyncEmptyError)
    expect(state.latest()).toBe(7)
  })

  it('preserves exact failures and prior yields until an explicit retry', async () => {
    const state = new AsyncState<number>()
    const token = state.begin()
    state.publish(token.generation, 1, false)
    const failure = { reason: 'stream failed' }
    state.reject(token.generation, failure)
    await token
    expect(thrown(() => state.read())).toBe(failure)
    expect(state.latest()).toBe(1)
    const retry = state.begin()
    expect(state.snapshot.status).toBe('refreshing')
    state.publish(retry.generation, 2)
    expect(state.read()).toBe(2)
  })

  it('disposal is terminal, releases waiters, and allows only retained-value inspection', async () => {
    const state = new AsyncState<number>()
    const value = state.begin()
    state.publish(value.generation, 4)
    const pending = state.begin()
    expect(state.dispose()).toBe(true)
    await pending
    const disposed = state.snapshot
    expect(state.publish(pending.generation, 5)).toBe(false)
    expect(state.reject(pending.generation, 'late')).toBe(false)
    expect(state.dispose()).toBe(false)
    expect(state.snapshot).toBe(disposed)
    expect(state.latest()).toBe(4)
    expect(() => state.read()).toThrow(AsyncDisposedError)
    expect(() => state.begin()).toThrow(AsyncDisposedError)
    const neverStarted = new AsyncState<number>()
    neverStarted.dispose()
    expect(() => neverStarted.latest()).toThrow(AsyncDisposedError)
  })

  it('publishes immutable snapshots without changing user-owned values', () => {
    const state = new AsyncState<{ count: number }>()
    const token = state.begin()
    const pending = state.snapshot
    const value = { count: 1 }
    state.publish(token.generation, value)
    expect(pending.status).toBe('pending')
    expect(Object.isFrozen(state.snapshot)).toBe(true)
    expect(Object.isFrozen(value)).toBe(false)
    expect(state.read()).toBe(value)
    expect(isAsyncPending(token)).toBe(true)
    for (const ordinary of [undefined, null, 0, {}, Promise.resolve(), { then() {} }]) {
      expect(isAsyncPending(ordinary)).toBe(false)
    }
  })

  it('does not turn arbitrary rejection values into readiness or replace their identity', () => {
    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    const promise = Promise.resolve('ordinary error value')
    for (const failure of [null, undefined, promise, revoked.proxy]) {
      const state = new AsyncState<number>()
      const token = state.begin()
      state.reject(token.generation, failure)
      expect(thrown(() => state.read())).toBe(failure)
      expect(isAsyncPending(failure)).toBe(false)
    }
  })
})

it('ordinary Promise-valued memos retain Promise identity and synchronous tracking', async () => {
  let resolve!: (value: number) => void
  const promise = new Promise<number>(done => {
    resolve = done
  })
  const source = signal(0)
  let runs = 0
  const memo = createMemo(() => {
    source()
    runs++
    return promise
  })
  const seen: Promise<number>[] = []
  const stop = effect(() => {
    seen.push(memo())
  })
  expect(seen).toEqual([promise])
  resolve(42)
  await promise
  flush()
  expect(runs).toBe(1)
  expect(seen).toEqual([promise])
  source(1)
  flush()
  expect(runs).toBe(2)
  expect(memo()).toBe(promise)
  expect(seen).toEqual([promise])
  stop()
})
