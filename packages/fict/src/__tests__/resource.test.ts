import { Suspense, createSignal, createRoot, render } from 'fict-runtime'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { resource } from '../resource'

const tick = () =>
  new Promise<void>(resolve =>
    typeof queueMicrotask === 'function'
      ? queueMicrotask(resolve)
      : Promise.resolve().then(resolve),
  )

describe('resource', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('resets and refetches when reset token changes', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce('a').mockResolvedValueOnce('b')
    const resetKey = createSignal(0)
    const r = resource<string, void>({
      fetch: fetcher,
      reset: () => resetKey(),
    })

    let result: any
    createRoot(() => {
      result = r.read(() => undefined)
    })

    await vi.runAllTimersAsync()
    await tick()
    expect(result.data).toBe('a')
    expect(fetcher).toHaveBeenCalledTimes(1)

    resetKey(1)
    await tick()
    await vi.runAllTimersAsync()
    await tick()

    expect(result.data).toBe('b')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('should fetch data', async () => {
    const fetcher = vi.fn().mockResolvedValue('success')
    const r = resource(fetcher)

    let result: any

    createRoot(() => {
      result = r.read(() => null)
    })

    expect(result.loading).toBe(true)
    expect(result.data).toBe(undefined)

    await vi.runAllTimersAsync()
    // Wait for promise microtasks
    await Promise.resolve()

    expect(result.loading).toBe(false)
    expect(result.data).toBe('success')
  })

  it('should react to arguments change', async () => {
    const fetcher = vi.fn((_, arg) => Promise.resolve(`echo ${arg}`))
    const r = resource(fetcher)

    const arg = createSignal('A')
    let result: any

    createRoot(() => {
      result = r.read(arg)
    })

    await vi.runAllTimersAsync()
    await Promise.resolve()
    expect(result.data).toBe('echo A')

    arg('B')
    await tick()

    await vi.runAllTimersAsync()
    await Promise.resolve()
    expect(result.data).toBe('echo B')
  })

  it('maintains separate cache entries when switching keys over time', async () => {
    const fetcher = vi.fn((_, arg: string) => Promise.resolve(`user:${arg}`))
    const r = resource(fetcher)
    const arg = createSignal('one')
    let result: any

    createRoot(() => {
      result = r.read(arg)
    })

    await vi.runAllTimersAsync()
    await tick()
    expect(result.data).toBe('user:one')
    expect(fetcher).toHaveBeenCalledTimes(1)

    arg('two')
    await tick()
    await vi.runAllTimersAsync()
    await tick()
    expect(result.data).toBe('user:two')
    expect(fetcher).toHaveBeenCalledTimes(2)

    arg('one')
    await tick()
    await vi.runAllTimersAsync()
    await tick()
    expect(result.data).toBe('user:one')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('should abort previous request', async () => {
    const abortSpy = vi.fn()
    const fetcher = vi.fn(({ signal }) => {
      signal.addEventListener('abort', abortSpy)
      return new Promise(resolve => setTimeout(() => resolve('done'), 100))
    })

    const r = resource({ fetch: fetcher, key: 'k' })

    let result: any
    createRoot(() => {
      result = r.read(() => undefined)
    })

    // Trigger a second request before the first resolves to force abort
    result.refresh()
    await tick()
    result.refresh()
    await tick()

    expect(abortSpy).toHaveBeenCalled()
  })

  it('supports suspense fallback while fetching', async () => {
    vi.useRealTimers()
    const fetcher = vi.fn(() => new Promise(resolve => setTimeout(() => resolve('done'), 0)))
    const r = resource({ fetch: fetcher, suspense: true, key: ['static'] })
    const container = document.createElement('div')
    let lastResult: any
    const args = () => null

    const View = () => {
      const result = r.read(args)
      lastResult = result
      return { type: 'span', props: { children: result.data } }
    }

    const dispose = render(
      () => ({
        type: Suspense as any,
        props: {
          fallback: 'loading',
          children: { type: View, props: {} },
        },
      }),
      container,
    )

    await tick()
    expect(container.textContent).toBe('loading')

    await new Promise(resolve => setTimeout(resolve, 1))
    await tick()
    await tick()
    await tick()

    expect(container.textContent).toBe('done')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(lastResult?.loading).toBe(false)
    expect(lastResult?.data).toBe('done')
    dispose()
  })

  it('dedupes concurrent reads for the same key', async () => {
    const fetcher = vi.fn().mockResolvedValue('ok')
    const r = resource(fetcher)

    let first: any
    let second: any

    createRoot(() => {
      first = r.read(() => 'k')
      second = r.read(() => 'k')
    })

    await vi.runAllTimersAsync()
    await tick()

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(first.data).toBe('ok')
    expect(second.data).toBe('ok')
  })

  it('uses cached value without refetch until refresh or args change', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce('first').mockResolvedValueOnce('second')
    const r = resource(fetcher)

    let result: any
    const arg = createSignal('key')

    createRoot(() => {
      result = r.read(arg)
    })

    await vi.runAllTimersAsync()
    await tick()
    expect(result.data).toBe('first')
    expect(fetcher).toHaveBeenCalledTimes(1)

    // No arg change -> no refetch
    await vi.runAllTimersAsync()
    await tick()
    expect(result.data).toBe('first')
    expect(fetcher).toHaveBeenCalledTimes(1)

    // Trigger refresh to force refetch
    result.refresh()
    await vi.runAllTimersAsync()
    await tick()
    expect(result.data).toBe('second')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('stale-while-revalidate keeps old data while refreshing', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2)
    const r = resource<number, void>({
      fetch: fetcher,
      cache: { staleWhileRevalidate: true, ttlMs: 0 },
    })

    let result: any
    createRoot(() => {
      result = r.read(() => undefined)
    })

    await vi.runAllTimersAsync()
    await tick()
    expect(result.data).toBe(1)

    // Force refresh, but should keep old data visible during revalidate
    result.refresh()
    expect(result.data).toBe(1)
    await vi.runAllTimersAsync()
    await tick()
    expect(result.data).toBe(2)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('supports invalidate and prefetch helpers', async () => {
    const fetcher = vi.fn().mockResolvedValue('value')
    const r = resource(fetcher)

    // prefetch before read
    r.prefetch('k')
    await vi.runAllTimersAsync()
    await tick()

    let result: any
    createRoot(() => {
      result = r.read(() => 'k')
    })
    expect(result.data).toBe('value')
    expect(fetcher).toHaveBeenCalledTimes(1)

    // invalidate triggers next read to refetch
    r.invalidate('k')
    createRoot(() => {
      result = r.read(() => 'k')
    })
    await vi.runAllTimersAsync()
    await tick()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(result.data).toBe('value')
  })
})
