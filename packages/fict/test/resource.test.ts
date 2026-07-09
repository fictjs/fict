import { ErrorBoundary, Suspense, createRoot, render } from '@fictjs/runtime'
import { createSignal, reactive } from '@fictjs/runtime/advanced'
import { __fictCreateSSRSession, __fictRunWithSSRSession } from '@fictjs/runtime/internal'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { resource } from '../src/resource'

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
      reset: reactive(() => resetKey()),
    })

    let result: any
    createRoot(() => {
      result = r.read(undefined)
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
      result = r.read(null)
    })

    expect(result.loading).toBe(true)
    expect(result.data).toBe(undefined)

    await vi.runAllTimersAsync()
    // Wait for promise microtasks
    await Promise.resolve()

    expect(result.loading).toBe(false)
    expect(result.data).toBe('success')
  })

  it('treats plain function read args as values', async () => {
    const fnArg = vi.fn(() => 'value')
    const fetcher = vi.fn((_, arg: () => string) => Promise.resolve(arg))
    const r = resource<() => string, () => string>(fetcher)

    let result: any
    createRoot(() => {
      result = r.read(fnArg)
    })

    await vi.runAllTimersAsync()
    await tick()

    expect(fetcher).toHaveBeenCalledWith(expect.any(Object), fnArg)
    expect(result.data).toBe(fnArg)
    expect(fnArg).not.toHaveBeenCalled()
  })

  it('treats plain function reset options as static token values', async () => {
    const resetToken = vi.fn()
    const fetcher = vi.fn().mockResolvedValue('ok')
    const r = resource<string, void>({
      fetch: fetcher,
      reset: resetToken,
    })

    let result: any
    createRoot(() => {
      result = r.read(undefined)
    })

    await vi.runAllTimersAsync()
    await tick()

    expect(result.data).toBe('ok')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(resetToken).not.toHaveBeenCalled()
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
      result = r.read(undefined)
    })

    // Trigger a second request before the first resolves to force abort
    result.refresh()
    await tick()
    result.refresh()
    await tick()

    expect(abortSpy).toHaveBeenCalled()
  })

  it('does not let stale abort rejection clear the newest controller', async () => {
    const abortSpy = vi.fn()
    const rejecters: Array<(err: unknown) => void> = []
    const fetcher = vi.fn(({ signal }) => {
      signal.addEventListener('abort', abortSpy)
      return new Promise<string>((_, reject) => {
        rejecters.push(reject)
      })
    })
    const r = resource<string, void>({ fetch: fetcher, key: 'k' })
    let result: any

    createRoot(() => {
      result = r.read(undefined)
    })

    expect(fetcher).toHaveBeenCalledTimes(1)

    result.refresh()
    await tick()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(abortSpy).toHaveBeenCalledTimes(1)

    rejecters[0]?.(new DOMException('aborted later', 'AbortError'))
    await tick()

    result.refresh()
    await tick()

    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(abortSpy).toHaveBeenCalledTimes(2)
  })

  it('does not let stale success clear the newest controller', async () => {
    const abortSpy = vi.fn()
    const resolvers: Array<(value: string) => void> = []
    const fetcher = vi.fn(({ signal }) => {
      signal.addEventListener('abort', abortSpy)
      return new Promise<string>(resolve => {
        resolvers.push(resolve)
      })
    })
    const r = resource<string, void>({ fetch: fetcher, key: 'k' })
    let result: any

    createRoot(() => {
      result = r.read(undefined)
    })

    result.refresh()
    await tick()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(abortSpy).toHaveBeenCalledTimes(1)

    resolvers[0]?.('stale')
    await tick()

    result.refresh()
    await tick()

    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(abortSpy).toHaveBeenCalledTimes(2)
  })

  it('preserves the newest controller after stale args-change completion', async () => {
    const abortSpy = vi.fn()
    const resolvers: Array<(value: string) => void> = []
    const fetcher = vi.fn(({ signal }, key: string) => {
      signal.addEventListener('abort', abortSpy)
      return new Promise<string>(resolve => {
        resolvers.push(value => resolve(`${key}:${value}`))
      })
    })
    const r = resource<string, string>({ fetch: fetcher, key: 'static' })
    const arg = createSignal('a')
    let result: any

    createRoot(() => {
      result = r.read(arg)
    })

    arg('b')
    await tick()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(abortSpy).toHaveBeenCalledTimes(1)

    resolvers[0]?.('stale')
    await tick()

    arg('c')
    await tick()

    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(abortSpy).toHaveBeenCalledTimes(2)
    expect(result.loading).toBe(true)
  })

  it('supports suspense fallback while fetching', async () => {
    vi.useRealTimers()
    const fetcher = vi.fn(() => new Promise(resolve => setTimeout(() => resolve('done'), 0)))
    const r = resource({ fetch: fetcher, suspense: true, key: ['static'] })
    const container = document.createElement('div')
    let lastResult: any

    const View = () => {
      const result = r.read(null)
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

  it('does not abort initial no-cache suspense fetches on suspended attempt cleanup', async () => {
    const abortSpy = vi.fn()
    let resolveFetch: ((value: string) => void) | undefined
    const fetcher = vi.fn(
      ({ signal }) =>
        new Promise<string>(resolve => {
          signal.addEventListener('abort', abortSpy)
          resolveFetch = resolve
        }),
    )
    const r = resource<string, string>({
      fetch: fetcher,
      suspense: true,
      cache: { mode: 'none' },
    })
    const container = document.createElement('div')

    const View = () => {
      const result = r.read('k')
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
    expect(abortSpy).not.toHaveBeenCalled()

    resolveFetch?.('ready')
    await tick()
    await tick()
    await tick()

    expect(container.textContent).toBe('ready')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(abortSpy).not.toHaveBeenCalled()
    dispose()
  })

  it('routes no-cache suspense fetch failures through ErrorBoundary', async () => {
    const error = new Error('load failed')
    let rejectFetch: ((err: unknown) => void) | undefined
    const fetcher = vi.fn(
      () =>
        new Promise<string>((_, reject) => {
          rejectFetch = reject
        }),
    )
    const r = resource<string, string>({
      fetch: fetcher,
      suspense: true,
      cache: { mode: 'none' },
    })
    const container = document.createElement('div')
    let captured: unknown = null

    const View = () => {
      const result = r.read('k')
      return { type: 'span', props: { children: result.data } }
    }

    const dispose = render(
      () => ({
        type: ErrorBoundary as any,
        props: {
          fallback: 'error',
          onError: (err: unknown) => {
            captured = err
          },
          children: {
            type: Suspense as any,
            props: {
              fallback: 'loading',
              children: { type: View, props: {} },
            },
          },
        },
      }),
      container,
    )

    await tick()
    expect(container.textContent).toBe('loading')

    rejectFetch?.(error)
    await tick()
    await tick()

    expect(captured).toBe(error)
    expect(container.textContent).toBe('error')
    dispose()
  })

  it('keeps non-suspense no-cache cleanup abort behavior', async () => {
    const abortSpy = vi.fn()
    const fetcher = vi.fn(({ signal }) => {
      signal.addEventListener('abort', abortSpy)
      return new Promise<string>(() => {})
    })
    const r = resource<string, string>({ fetch: fetcher, cache: { mode: 'none' } })

    const { dispose } = createRoot(() => {
      r.read('k')
    })

    expect(fetcher).toHaveBeenCalledTimes(1)
    dispose()

    expect(abortSpy).toHaveBeenCalledTimes(1)
  })

  it('retries a pending suspense read after specific-key invalidation', async () => {
    const resolvers: Array<(value: string) => void> = []
    const fetcher = vi.fn(
      ({ signal }) =>
        new Promise<string>((resolve, reject) => {
          resolvers.push(resolve)
          signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          })
        }),
    )
    const r = resource<string, string>({ fetch: fetcher, suspense: true })
    const container = document.createElement('div')

    const View = () => {
      const result = r.read('k')
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
    expect(fetcher).toHaveBeenCalledTimes(1)

    r.invalidate('k')
    await tick()
    await tick()

    expect(container.textContent).toBe('loading')
    expect(fetcher).toHaveBeenCalledTimes(2)

    resolvers[0]?.('stale')
    await tick()
    expect(container.textContent).toBe('loading')

    resolvers[1]?.('fresh')
    await tick()
    await tick()
    await tick()

    expect(container.textContent).toBe('fresh')
    dispose()
  })

  it('retries all pending suspense reads after invalidate-all', async () => {
    const resolvers: Array<(value: string) => void> = []
    const fetcher = vi.fn(
      ({ signal }, key: string) =>
        new Promise<string>((resolve, reject) => {
          resolvers.push(resolve)
          signal.addEventListener('abort', () => {
            reject(new DOMException(`aborted:${key}`, 'AbortError'))
          })
        }),
    )
    const r = resource<string, string>({ fetch: fetcher, suspense: true })
    const container = document.createElement('div')

    const View = () => {
      const first = r.read('a')
      const second = r.read('b')
      return {
        type: 'span',
        props: { children: `${first.data}:${second.data}` },
      }
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
    await tick()
    expect(container.textContent).toBe('loading')
    expect(fetcher).toHaveBeenCalledTimes(2)

    r.invalidate()
    await tick()
    await tick()

    expect(container.textContent).toBe('loading')
    expect(fetcher).toHaveBeenCalledTimes(4)

    resolvers[2]?.('fresh-a')
    resolvers[3]?.('fresh-b')
    await tick()
    await tick()
    await tick()

    expect(container.textContent).toBe('fresh-a:fresh-b')
    dispose()
  })

  it('keeps non-suspense invalidation retry behavior unchanged', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce('first').mockResolvedValueOnce('second')
    const r = resource<string, string>({ fetch: fetcher })
    let result: any

    createRoot(() => {
      result = r.read('k')
    })

    expect(result.loading).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(1)

    r.invalidate('k')
    await tick()
    await vi.runAllTimersAsync()
    await tick()

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(result.data).toBe('second')
  })

  it('does not create unhandled suspense tokens for failing prefetches', async () => {
    let resolveFetch: ((value: string) => void) | undefined
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('prefetch failed'))
      .mockImplementationOnce(
        () =>
          new Promise<string>(resolve => {
            resolveFetch = resolve
          }),
      )
    const r = resource<string, string>({ fetch: fetcher, suspense: true })
    const container = document.createElement('div')

    r.prefetch('k')
    await tick()
    await tick()

    const View = () => {
      const result = r.read('k')
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
    expect(fetcher).toHaveBeenCalledTimes(2)

    resolveFetch?.('ready')
    await tick()
    await tick()
    await tick()
    expect(container.textContent).toBe('ready')
    dispose()
  })

  it('reuses successful suspense prefetches on later reads', async () => {
    const fetcher = vi.fn().mockResolvedValue('prefetched')
    const r = resource<string, string>({ fetch: fetcher, suspense: true })
    const container = document.createElement('div')

    r.prefetch('k')
    await tick()
    await tick()

    const View = () => {
      const result = r.read('k')
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
    expect(container.textContent).toBe('prefetched')
    expect(fetcher).toHaveBeenCalledTimes(1)
    dispose()
  })

  it('attaches suspense reads to an in-flight prefetch', async () => {
    let resolveFetch: ((value: string) => void) | undefined
    const fetcher = vi.fn(
      () =>
        new Promise<string>(resolve => {
          resolveFetch = resolve
        }),
    )
    const r = resource<string, string>({ fetch: fetcher, suspense: true })
    const container = document.createElement('div')

    r.prefetch('k')
    const View = () => {
      const result = r.read('k')
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
    expect(fetcher).toHaveBeenCalledTimes(1)

    resolveFetch?.('ready')
    await tick()
    await tick()
    await tick()

    expect(container.textContent).toBe('ready')
    expect(fetcher).toHaveBeenCalledTimes(1)
    dispose()
  })

  it('keeps non-suspense prefetch failures internal', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('prefetch failed'))
    const r = resource<string, string>({ fetch: fetcher })

    r.prefetch('k')
    await tick()
    await tick()

    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('uses explicit falsy key overrides for prefetch and mutate', async () => {
    const fetcher = vi.fn((_, arg: unknown) => Promise.resolve(`value:${String(arg)}`))
    const r = resource<string, unknown>(fetcher)
    const objectKey = { id: 1 }
    const cases: Array<{ label: string; key: unknown; prefetchArg: string }> = [
      { label: 'null', key: null, prefetchArg: 'prefetched:null' },
      { label: 'undefined', key: undefined, prefetchArg: 'prefetched:undefined' },
      { label: 'zero', key: 0, prefetchArg: 'prefetched:zero' },
      { label: 'false', key: false, prefetchArg: 'prefetched:false' },
      { label: 'empty', key: '', prefetchArg: 'prefetched:empty' },
      { label: 'object', key: objectKey, prefetchArg: 'prefetched:object' },
    ]

    for (const item of cases) {
      r.prefetch(item.prefetchArg, item.key)
      await vi.runAllTimersAsync()
      await tick()

      let result: any
      const { dispose } = createRoot(() => {
        result = r.read(item.key)
      })

      await tick()
      expect(result.data).toBe(`value:${item.prefetchArg}`)

      r.mutate('ignored', `optimistic:${item.label}`, { key: item.key })
      expect(result.data).toBe(`optimistic:${item.label}`)

      dispose()
    }
  })

  it('invalidates null as a specific resource key', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce('null:first').mockResolvedValueOnce('null:second')
    const r = resource<string, null>({ fetch: fetcher })
    let result: any

    createRoot(() => {
      result = r.read(null)
    })

    await vi.runAllTimersAsync()
    await tick()
    expect(result.data).toBe('null:first')
    expect(fetcher).toHaveBeenCalledTimes(1)

    r.invalidate(null)
    await tick()
    await vi.runAllTimersAsync()
    await tick()

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(result.data).toBe('null:second')
  })

  it('dedupes concurrent reads for the same key', async () => {
    const fetcher = vi.fn().mockResolvedValue('ok')
    const r = resource(fetcher)

    let first: any
    let second: any

    createRoot(() => {
      first = r.read('k')
      second = r.read('k')
    })

    await vi.runAllTimersAsync()
    await tick()

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(first.data).toBe('ok')
    expect(second.data).toBe('ok')
  })

  it('isolates the default memory cache between SSR request sessions', async () => {
    let currentUser = 'Alice'
    const fetcher = vi.fn(() => Promise.resolve(currentUser))
    const r = resource<string, string>(fetcher)
    const aliceSession = __fictCreateSSRSession()
    const bobSession = __fictCreateSSRSession()

    const aliceRoot = __fictRunWithSSRSession(aliceSession, () =>
      createRoot(() => r.read('viewer')),
    )
    await vi.runAllTimersAsync()
    await tick()

    expect(aliceRoot.value.data).toBe('Alice')
    expect(fetcher).toHaveBeenCalledTimes(1)

    currentUser = 'Bob'
    const bobRoot = __fictRunWithSSRSession(bobSession, () => createRoot(() => r.read('viewer')))

    expect(bobRoot.value.data).toBeUndefined()
    expect(fetcher).toHaveBeenCalledTimes(2)

    await vi.runAllTimersAsync()
    await tick()

    expect(bobRoot.value.data).toBe('Bob')
    expect(aliceRoot.value.data).toBe('Alice')

    aliceRoot.dispose()
    bobRoot.dispose()
  })

  it('deduplicates equal reads within one SSR request session', async () => {
    const fetcher = vi.fn().mockResolvedValue('Alice')
    const r = resource<string, string>(fetcher)
    const session = __fictCreateSSRSession()

    const requestRoot = __fictRunWithSSRSession(session, () =>
      createRoot(() => [r.read('viewer'), r.read('viewer')] as const),
    )

    await vi.runAllTimersAsync()
    await tick()

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(requestRoot.value[0].data).toBe('Alice')
    expect(requestRoot.value[1].data).toBe('Alice')
    requestRoot.dispose()
  })

  it('keeps client memory caching shared across roots by default', async () => {
    const fetcher = vi.fn().mockResolvedValue('client-value')
    const r = resource<string, string>(fetcher)

    const firstRoot = createRoot(() => r.read('key'))
    await vi.runAllTimersAsync()
    await tick()

    const secondRoot = createRoot(() => r.read('key'))
    await tick()

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(firstRoot.value.data).toBe('client-value')
    expect(secondRoot.value.data).toBe('client-value')

    firstRoot.dispose()
    secondRoot.dispose()
  })

  it('shares memory across SSR sessions only when explicitly requested', async () => {
    let currentUser = 'Alice'
    const fetcher = vi.fn(() => Promise.resolve(currentUser))
    const r = resource<string, string>({
      fetch: fetcher,
      cache: { scope: 'shared' },
    })

    const aliceRoot = __fictRunWithSSRSession(__fictCreateSSRSession(), () =>
      createRoot(() => r.read('viewer')),
    )
    await vi.runAllTimersAsync()
    await tick()

    currentUser = 'Bob'
    const bobRoot = __fictRunWithSSRSession(__fictCreateSSRSession(), () =>
      createRoot(() => r.read('viewer')),
    )

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(aliceRoot.value.data).toBe('Alice')
    expect(bobRoot.value.data).toBe('Alice')

    aliceRoot.dispose()
    bobRoot.dispose()
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

  it('dedupes prefetch calls for the same key', async () => {
    const fetcher = vi.fn(() => Promise.resolve('ok'))
    const r = resource(fetcher)

    r.prefetch('k')
    r.prefetch('k')

    await vi.runAllTimersAsync()
    await tick()

    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('stale-while-revalidate keeps old data while refreshing', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2)
    const r = resource<number, void>({
      fetch: fetcher,
      cache: { staleWhileRevalidate: true, ttlMs: 0 },
    })

    let result: any
    createRoot(() => {
      result = r.read(undefined)
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

  it('stale-while-revalidate does not show loading state when revalidating expired data', async () => {
    let resolveSecond: (value: number) => void
    const secondPromise = new Promise<number>(resolve => {
      resolveSecond = resolve
    })
    const fetcher = vi.fn().mockResolvedValueOnce(1).mockReturnValueOnce(secondPromise)
    const r = resource<number, void>({
      fetch: fetcher,
      cache: { staleWhileRevalidate: true, ttlMs: 100 },
    })

    let result: any
    const loadingStates: boolean[] = []
    createRoot(() => {
      result = r.read(undefined)
    })

    // Initial fetch shows loading
    loadingStates.push(result.loading)
    await vi.runAllTimersAsync()
    await tick()
    expect(result.data).toBe(1)
    expect(result.loading).toBe(false)

    // Advance time past TTL to expire the cache
    vi.advanceTimersByTime(150)

    // Create new read to trigger revalidation of expired data
    let result2: any
    createRoot(() => {
      result2 = r.read(undefined)
    })
    await tick()

    // Should still show old data without loading state (stale-while-revalidate)
    expect(result2.data).toBe(1)
    expect(result2.loading).toBe(false) // Key assertion: no loading during revalidation

    // Complete the background refresh
    resolveSecond!(2)
    await vi.runAllTimersAsync()
    await tick()

    // Now should show new data
    expect(result2.data).toBe(2)
    expect(result2.loading).toBe(false)
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
      result = r.read('k')
    })
    expect(result.data).toBe('value')
    expect(fetcher).toHaveBeenCalledTimes(1)

    // invalidate triggers next read to refetch
    r.invalidate('k')
    createRoot(() => {
      result = r.read('k')
    })
    await vi.runAllTimersAsync()
    await tick()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(result.data).toBe('value')
  })

  it('supports mutate with optimistic updates', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce('server').mockResolvedValueOnce('fresh')
    const r = resource(fetcher)

    let result: any
    createRoot(() => {
      result = r.read('k')
    })

    await vi.runAllTimersAsync()
    await tick()
    expect(result.data).toBe('server')
    expect(fetcher).toHaveBeenCalledTimes(1)

    r.mutate('k', 'optimistic')
    expect(result.data).toBe('optimistic')
    expect(fetcher).toHaveBeenCalledTimes(1)

    r.mutate('k', 'optimistic', { revalidate: true })
    await tick()
    await vi.runAllTimersAsync()
    await tick()
    expect(result.data).toBe('fresh')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('shares one cache entry across structurally equal object args', async () => {
    const fetcher = vi.fn(({ signal: _signal }, args: { userId: number }) =>
      Promise.resolve(`user:${args.userId}`),
    )
    const r = resource<string, { userId: number }>({ fetch: fetcher })

    let first: any
    let second: any
    createRoot(() => {
      // Fresh object literals with equal contents must hit the same entry.
      first = r.read({ userId: 1 })
      second = r.read({ userId: 1 })
    })

    await vi.runAllTimersAsync()
    await tick()
    expect(first.data).toBe('user:1')
    expect(second.data).toBe('user:1')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('does not abort in-flight fetches when equal args objects are re-read', async () => {
    const abortSpy = vi.fn()
    let resolveFetch: ((value: string) => void) | undefined
    const fetcher = vi.fn(({ signal }, _args: { id: number }) => {
      signal.addEventListener('abort', abortSpy)
      return new Promise<string>(resolve => {
        resolveFetch = resolve
      })
    })
    const r = resource<string, { id: number }>({ fetch: fetcher })
    const bump = createSignal(0)

    let result: any
    createRoot(() => {
      // The getter re-evaluates per dependency change, producing a fresh
      // (but structurally equal) args object each time.
      result = r.read(reactive(() => (bump(), { id: 7 })))
    })

    bump(1)
    await tick()
    bump(2)
    await tick()

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(abortSpy).not.toHaveBeenCalled()

    resolveFetch?.('done')
    await vi.runAllTimersAsync()
    await tick()
    expect(result.data).toBe('done')
  })

  it('evicts least-recently-used entries beyond maxEntries', async () => {
    const fetcher = vi.fn((_, id: number) => Promise.resolve(`v:${id}`))
    const r = resource<string, number>({ fetch: fetcher, cache: { maxEntries: 2 } })

    for (const id of [1, 2, 3]) {
      r.prefetch(id)
      await vi.runAllTimersAsync()
      await tick()
    }
    expect(fetcher).toHaveBeenCalledTimes(3)

    // Entry 1 was evicted (LRU): reading it must refetch.
    let result: any
    const { dispose } = createRoot(() => {
      result = r.read(1)
    })
    await vi.runAllTimersAsync()
    await tick()
    expect(result.data).toBe('v:1')
    expect(fetcher).toHaveBeenCalledTimes(4)
    dispose()

    // Entry 3 stayed cached: reading it must not refetch.
    const { dispose: dispose3 } = createRoot(() => {
      result = r.read(3)
    })
    await tick()
    expect(result.data).toBe('v:3')
    expect(fetcher).toHaveBeenCalledTimes(4)
    dispose3()
  })
})
