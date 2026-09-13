import { afterEach, describe, expect, it } from 'vitest'
import { createRoot, useTransition } from '@fictjs/runtime'
import { createSignal, reactive } from '@fictjs/runtime/advanced'
import { __resetReactiveState } from '@fictjs/runtime/internal'
import { resource } from '../src/resource'

const disposers: (() => void)[] = []
afterEach(() => {
  while (disposers.length) disposers.pop()!()
  __resetReactiveState()
})
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => {
    resolve = yes
  })
  return { promise, resolve }
}
const drain = async () => {
  for (let i = 0; i < 24; i++) await Promise.resolve()
}

describe('Resource causal transitions', () => {
  it('waits for a request caused indirectly by a reactive argument update', async () => {
    const request = deferred<string>()
    const query = resource<string, number>((_, key) =>
      key ? request.promise : Promise.resolve('initial'),
    )
    const owner = createRoot(() => {
      const key = createSignal(0)
      const result = query.read(reactive(() => key()))
      const [pending, start] = useTransition()
      return { key, result, pending, start }
    })
    disposers.push(owner.dispose)
    await drain()
    owner.value.start(() => owner.value.key(1))
    await drain()
    expect(owner.value.pending()).toBe(true)
    expect(owner.value.result.loading).toBe(true)
    request.resolve('current')
    await drain()
    expect(owner.value.result.data).toBe('current')
    expect(owner.value.pending()).toBe(false)
  })

  it('joins a deduplicated request without making unrelated prefetch work pending', async () => {
    const shared = deferred<string>()
    const background = deferred<string>()
    let calls = 0
    const query = resource<string, number>((_, key) => {
      calls++
      return key === 1
        ? shared.promise
        : key === 2
          ? background.promise
          : Promise.resolve('initial')
    })
    query.prefetch(1)
    query.prefetch(2)
    const owner = createRoot(() => {
      const key = createSignal(0)
      const result = query.read(reactive(() => key()))
      const [pending, start] = useTransition()
      return { key, result, pending, start }
    })
    disposers.push(owner.dispose)
    await drain()
    owner.value.start(() => owner.value.key(1))
    await drain()
    expect(owner.value.pending()).toBe(true)
    expect(calls).toBe(3)
    shared.resolve('shared')
    await drain()
    expect(owner.value.pending()).toBe(false)
    expect(owner.value.result.data).toBe('shared')
  })

  it('releases owner readiness while a shared cached request remains alive', async () => {
    const request = deferred<string>()
    let signal!: AbortSignal
    const query = resource<string, number>(({ signal: current }, key) => {
      signal = current
      return key ? request.promise : Promise.resolve('initial')
    })
    const owner = createRoot(() => {
      const key = createSignal(0)
      query.read(reactive(() => key()))
      const [pending, start] = useTransition()
      return { key, pending, start }
    })
    await drain()
    owner.value.start(() => owner.value.key(1))
    await drain()
    expect(owner.value.pending()).toBe(true)
    owner.dispose()
    expect(owner.value.pending()).toBe(false)
    expect(signal.aborted).toBe(false)
    request.resolve('cache result')
    await drain()
    expect(owner.value.pending()).toBe(false)
    const reader = createRoot(() => query.read(1))
    disposers.push(reader.dispose)
    expect(reader.value.data).toBe('cache result')
  })

  it('releases an abandoned reader without cancelling useful cached transport', async () => {
    const requests = [deferred<string>(), deferred<string>()]
    const signals: AbortSignal[] = []
    const query = resource<string, number>(({ signal }, key) => {
      if (!key) return Promise.resolve('initial')
      signals.push(signal)
      return requests[key - 1]!.promise
    })
    const owner = createRoot(() => {
      const key = createSignal(0)
      const result = query.read(reactive(() => key()))
      return { key, result, first: useTransition(), second: useTransition() }
    })
    disposers.push(owner.dispose)
    await drain()
    const { key, first, second } = owner.value
    first[1](() => key(1))
    await drain()
    expect(first[0]()).toBe(true)
    second[1](() => key(2))
    await drain()
    expect(signals[0]!.aborted).toBe(false)
    expect([first[0](), second[0]()]).toEqual([false, true])
    requests[0]!.resolve('obsolete view')
    await drain()
    expect(second[0]()).toBe(true)
    requests[1]!.resolve('current view')
    await drain()
    expect(second[0]()).toBe(false)
    expect(owner.value.result.data).toBe('current view')
  })

  it('keeps a shared transition lease until its remaining reader is ready', async () => {
    const request = deferred<string>()
    const query = resource<string, number>((_, key) =>
      key ? request.promise : Promise.resolve('initial'),
    )
    const owner = createRoot(() => {
      const key = createSignal(0)
      const first = createRoot(() => query.read(reactive(() => key())))
      const second = createRoot(() => query.read(reactive(() => key())))
      const [pending, start] = useTransition()
      return { key, first, second, pending, start }
    })
    disposers.push(owner.dispose, owner.value.first.dispose, owner.value.second.dispose)
    await drain()
    owner.value.start(() => owner.value.key(1))
    await drain()
    owner.value.first.dispose()
    await drain()
    expect(owner.value.pending()).toBe(true)
    request.resolve('shared')
    await drain()
    expect(owner.value.second.value.data).toBe('shared')
    expect(owner.value.pending()).toBe(false)
  })
})
