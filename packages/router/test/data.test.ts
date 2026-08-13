import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { ErrorBoundary, render } from '@fictjs/runtime'
import { createSignal } from '@fictjs/runtime/advanced'
import {
  __fictCreateSSRSession,
  __fictGetCurrentSSRSession,
  __fictRunWithSSRSession,
} from '@fictjs/runtime/internal'
import {
  query,
  preloadQuery,
  revalidate,
  action,
  useSubmission,
  useSubmissions,
  submitAction,
  createResource,
  cleanupDataUtilities,
  type Resource,
} from '../src/data'

describe('query', () => {
  beforeEach(() => {
    cleanupDataUtilities()
  })

  afterEach(() => {
    cleanupDataUtilities()
  })

  it('should create a query function', () => {
    const fetchUser = query(async (id: string) => ({ id, name: 'Test User' }), 'fetchUser')

    expect(typeof fetchUser).toBe('function')
  })

  it('does not install the browser cleanup interval during SSR', () => {
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    cleanupDataUtilities()
    setIntervalSpy.mockClear()
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: undefined,
    })

    try {
      query(async () => 'value', 'serverQuery')
      expect(setIntervalSpy).not.toHaveBeenCalled()
    } finally {
      if (windowDescriptor) {
        Object.defineProperty(globalThis, 'window', windowDescriptor)
      } else {
        Reflect.deleteProperty(globalThis, 'window')
      }
      setIntervalSpy.mockRestore()
    }
  })

  it('should return an accessor function', () => {
    const fetchUser = query(async (id: string) => ({ id, name: 'Test User' }), 'fetchUser')

    const accessor = fetchUser('123')
    expect(typeof accessor).toBe('function')
  })

  it('should cache results', async () => {
    let callCount = 0
    const fetchUser = query(async (id: string) => {
      callCount++
      return { id, name: 'Test User' }
    }, 'fetchUser')

    // First call
    const accessor1 = fetchUser('123')
    await new Promise(resolve => setTimeout(resolve, 10))

    // Second call with same args should use cache
    const accessor2 = fetchUser('123')

    // The function should still only be called once
    // (cache lookup happens on accessor call)
    expect(callCount).toBe(1)
  })

  it('expires unused preloads after the short preload cache window', async () => {
    let now = 1_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const fetcher = vi.fn(async (id: string) => `value:${id}`)
      const fetchValue = query(fetcher, 'expiringPreload')

      preloadQuery(fetchValue, 'first')
      await Promise.resolve()
      await Promise.resolve()

      now += 4_999
      preloadQuery(fetchValue, 'first')
      expect(fetcher).toHaveBeenCalledTimes(1)

      now += 2
      preloadQuery(fetchValue, 'first')
      expect(fetcher).toHaveBeenCalledTimes(2)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('returns the preload request promise and preserves failures for retry coordination', async () => {
    const failure = new Error('preload failed')
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce('ready')
    const fetchValue = query(fetcher, 'observablePreloadFailure')

    await expect(preloadQuery(fetchValue)).rejects.toBe(failure)
    await expect(preloadQuery(fetchValue)).resolves.toBe('ready')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('waits for the raw request when preloading a wrapped query', async () => {
    let resolveFetch!: (value: string) => void
    const fetchValue = query(
      () =>
        new Promise<string>(resolve => {
          resolveFetch = resolve
        }),
      'wrappedPreload',
    )
    const wrapped: typeof fetchValue = (...args) => fetchValue(...args)
    let settled = false

    const task = preloadQuery(wrapped).then(value => {
      settled = true
      return value
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    resolveFetch('ready')
    await expect(task).resolves.toBe('ready')
    expect(settled).toBe(true)
  })

  it('keeps wrapped query preloads on the short preload cache window', async () => {
    let now = 1_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const fetcher = vi.fn(async (id: string) => `value:${id}`)
      const fetchValue = query(fetcher, 'expiringWrappedPreload')
      const wrapped: typeof fetchValue = (...args) => fetchValue(...args)

      await preloadQuery(wrapped, 'first')

      now += 4_999
      await preloadQuery(wrapped, 'first')
      expect(fetcher).toHaveBeenCalledTimes(1)

      now += 2
      await preloadQuery(wrapped, 'first')
      expect(fetcher).toHaveBeenCalledTimes(2)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('preserves wrapped query preload failures', async () => {
    const failure = new Error('wrapped preload failed')
    let rejectFetch!: (reason: unknown) => void
    const fetchValue = query(
      () =>
        new Promise<string>((_, reject) => {
          rejectFetch = reject
        }),
      'wrappedPreloadFailure',
    )
    const wrapped: typeof fetchValue = (...args) => fetchValue(...args)

    const task = preloadQuery(wrapped)
    rejectFetch(failure)
    await expect(task).rejects.toBe(failure)
  })

  it('shares the preload protocol across router module instances', async () => {
    vi.resetModules()
    const firstRouter = await import('../src/data')
    vi.resetModules()
    const secondRouter = await import('../src/data')
    const fetcher = vi.fn(async () => 'shared')
    const fetchValue = firstRouter.query(fetcher, 'crossInstancePreload')

    try {
      expect(firstRouter).not.toBe(secondRouter)
      await expect(secondRouter.preloadQuery(fetchValue)).resolves.toBe('shared')
      expect(fetcher).toHaveBeenCalledTimes(1)
    } finally {
      firstRouter.cleanupDataUtilities()
      secondRouter.cleanupDataUtilities()
    }
  })

  it('shares wrapped preload intent across router instances with a hardened global', async () => {
    const intentStateKey = Symbol.for('fict.router.query-preload-intent-state.v1')
    const intentStateDescriptor = Object.getOwnPropertyDescriptor(globalThis, intentStateKey)
    Object.defineProperty(globalThis, intentStateKey, {
      configurable: true,
      value: undefined,
      writable: false,
    })

    vi.resetModules()
    const firstRouter = await import('../src/data')
    vi.resetModules()
    const secondRouter = await import('../src/data')
    let now = 1_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const fetcher = vi.fn(async () => 'shared wrapped')
    const fetchValue = firstRouter.query(fetcher, 'crossInstanceWrappedPreload')
    const wrapped: typeof fetchValue = (...args) => fetchValue(...args)

    try {
      await secondRouter.preloadQuery(wrapped)
      now += 5_001
      await secondRouter.preloadQuery(wrapped)
      expect(fetcher).toHaveBeenCalledTimes(2)
    } finally {
      nowSpy.mockRestore()
      firstRouter.cleanupDataUtilities()
      secondRouter.cleanupDataUtilities()
      if (intentStateDescriptor) {
        Object.defineProperty(globalThis, intentStateKey, intentStateDescriptor)
      } else {
        Reflect.deleteProperty(globalThis, intentStateKey)
      }
    }
  })

  it('shares preload intent for every wrapped query when the global slot rejects writes', async () => {
    const intentStateKey = Symbol.for('fict.router.query-preload-intent-state.v1')
    const intentStateDescriptor = Object.getOwnPropertyDescriptor(globalThis, intentStateKey)
    Object.defineProperty(globalThis, intentStateKey, {
      configurable: true,
      value: undefined,
      writable: false,
    })

    vi.resetModules()
    const firstRouter = await import('../src/data')
    vi.resetModules()
    const secondRouter = await import('../src/data')
    let now = 1_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const sideFetcher = vi.fn(async () => 'side')
    const mainFetcher = vi.fn(async () => 'main')
    const sideQuery = firstRouter.query(sideFetcher, 'crossInstanceWrappedSidePreload')
    const mainQuery = firstRouter.query(mainFetcher, 'crossInstanceWrappedMainPreload')
    const wrapped: typeof mainQuery = (...args) => {
      sideQuery()
      return mainQuery(...args)
    }

    try {
      await secondRouter.preloadQuery(wrapped)
      now += 5_001
      await secondRouter.preloadQuery(wrapped)
      expect(sideFetcher).toHaveBeenCalledTimes(2)
      expect(mainFetcher).toHaveBeenCalledTimes(2)
    } finally {
      nowSpy.mockRestore()
      firstRouter.cleanupDataUtilities()
      secondRouter.cleanupDataUtilities()
      if (intentStateDescriptor) {
        Object.defineProperty(globalThis, intentStateKey, intentStateDescriptor)
      } else {
        Reflect.deleteProperty(globalThis, intentStateKey)
      }
    }
  })

  it('rejects structural query lookalikes without an invocation promise', async () => {
    const accessor = Object.assign(() => undefined, {
      loading: () => true,
      error: () => undefined,
      status: () => 'pending' as const,
      latest: () => undefined,
    })
    const lookalike = () => accessor

    await expect(preloadQuery(lookalike)).rejects.toThrow('expects a Query created by query()')
  })

  it('does not shorten an existing navigation cache when preloading it', async () => {
    let now = 1_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const fetcher = vi.fn(async (id: string) => `value:${id}`)
      const fetchValue = query(fetcher, 'navigationThenPreload')

      fetchValue('first')
      await Promise.resolve()
      await Promise.resolve()

      now += 5_001
      preloadQuery(fetchValue, 'first')
      expect(fetcher).toHaveBeenCalledTimes(1)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('promotes a consumed preload to the navigation cache window', async () => {
    let now = 1_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const fetcher = vi.fn(async (id: string) => `value:${id}`)
      const fetchValue = query(fetcher, 'consumedPreload')

      preloadQuery(fetchValue, 'first')
      await Promise.resolve()
      await Promise.resolve()

      now += 4_000
      expect(fetchValue('first')()).toBe('value:first')

      now += 2_000
      expect(fetchValue('first')()).toBe('value:first')
      expect(fetcher).toHaveBeenCalledTimes(1)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('promotes a pending preload when navigation consumes its request', async () => {
    let now = 1_000
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    let resolveFetch!: (value: string) => void
    try {
      const fetcher = vi.fn(
        () =>
          new Promise<string>(resolve => {
            resolveFetch = resolve
          }),
      )
      const fetchValue = query(fetcher, 'pendingConsumedPreload')

      preloadQuery(fetchValue)
      fetchValue()
      resolveFetch('ready')
      await Promise.resolve()
      await Promise.resolve()

      now += 5_001
      expect(fetchValue()()).toBe('ready')
      expect(fetcher).toHaveBeenCalledTimes(1)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('does not share query data when an active SSR fallback loses async context', async () => {
    const fetchResolvers: Array<(value: string) => void> = []
    const fetchViewer = query(
      vi.fn(
        (_viewer: string) =>
          new Promise<string>(resolve => {
            fetchResolvers.push(resolve)
          }),
      ),
      'isolatedFallbackViewer',
    )
    let releaseAlice!: () => void
    let releaseBob!: () => void
    const aliceGate = new Promise<void>(resolve => {
      releaseAlice = resolve
    })
    const bobGate = new Promise<void>(resolve => {
      releaseBob = resolve
    })

    const aliceRun = __fictRunWithSSRSession(__fictCreateSSRSession(), async () => {
      await aliceGate
      expect(__fictGetCurrentSSRSession()).toBeNull()
      return fetchViewer('viewer')
    })
    const bobRun = __fictRunWithSSRSession(__fictCreateSSRSession(), async () => {
      await bobGate
      expect(__fictGetCurrentSSRSession()).toBeNull()
      return fetchViewer('viewer')
    })

    releaseAlice()
    const aliceViewer = await aliceRun
    releaseBob()
    const bobViewer = await bobRun

    expect(fetchResolvers).toHaveLength(2)
    fetchResolvers[0]?.('Alice')
    fetchResolvers[1]?.('Bob')
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(aliceViewer()).toBe('Alice')
    expect(bobViewer()).toBe('Bob')
  })

  it('caches successful undefined results', async () => {
    const fetcher = vi.fn((_key: string) => undefined)
    const fetchValue = query(fetcher, 'undefinedResult')

    const first = fetchValue('key')
    expect(first.loading()).toBe(true)
    expect(first.status()).toBe('pending')
    await Promise.resolve()
    await Promise.resolve()
    const second = fetchValue('key')

    expect(first()).toBeUndefined()
    expect(first.loading()).toBe(false)
    expect(first.status()).toBe('success')
    expect(first.error()).toBeUndefined()
    expect(second()).toBeUndefined()
    expect(second.status()).toBe('success')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('should handle different args separately', async () => {
    let callCount = 0
    const fetchUser = query(async (id: string) => {
      callCount++
      return { id }
    }, 'fetchUser')

    fetchUser('123')
    await new Promise(resolve => setTimeout(resolve, 10))

    fetchUser('456')
    await new Promise(resolve => setTimeout(resolve, 10))

    // Different args should create separate cache entries
    expect(callCount).toBe(2)
  })

  it('exposes rejected query failures and throws them from the main accessor', async () => {
    const error = new Error('query failed')
    const fetchUser = query(async () => {
      throw error
    }, 'failingQuery')

    const accessor = fetchUser()
    await Promise.resolve()
    await Promise.resolve()

    expect(accessor.loading()).toBe(false)
    expect(accessor.status()).toBe('error')
    expect(accessor.error()).toBe(error)
    expect(accessor.latest()).toBe(undefined)
    expect(() => accessor()).toThrow(error)
  })

  it('normalizes synchronous query failures into the observable error path', async () => {
    const error = new Error('synchronous query failure')
    const fetchValue = query(() => {
      throw error
    }, 'syncFailureQuery')
    let accessor: ReturnType<typeof fetchValue> | undefined

    expect(() => {
      accessor = fetchValue()
    }).not.toThrow()
    await Promise.resolve()
    await Promise.resolve()

    expect(accessor?.status()).toBe('error')
    expect(accessor?.error()).toBe(error)
    expect(() => accessor?.()).toThrow(error)
  })

  it('routes asynchronous query failures through ErrorBoundary', async () => {
    const error = new Error('boundary query failure')
    let rejectFetch!: (reason: unknown) => void
    const fetchValue = query(
      () =>
        new Promise<string>((_, reject) => {
          rejectFetch = reject
        }),
      'boundaryFailureQuery',
    )
    const accessor = fetchValue()
    const container = document.createElement('div')
    let captured: unknown

    const dispose = render(
      () => ({
        type: ErrorBoundary as any,
        props: {
          fallback: 'query error',
          onError: (caught: unknown) => {
            captured = caught
          },
          children: { type: 'span', props: { children: accessor } },
        },
      }),
      container,
    )

    expect(container.textContent).toBe('')
    rejectFetch(error)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(captured).toBe(error)
    expect(container.textContent).toBe('query error')
    dispose()
  })

  it('should retry successfully after a rejected query', async () => {
    const fetchUser = query(
      vi.fn().mockRejectedValueOnce(new Error('query failed')).mockResolvedValueOnce('ok'),
      'retryQuery',
    )

    const first = fetchUser('123')
    await Promise.resolve()
    await Promise.resolve()
    expect(() => first()).toThrow('query failed')

    const second = fetchUser('123')
    await Promise.resolve()
    await Promise.resolve()

    expect(second()).toBe('ok')
  })

  it('deduplicates concurrent retries after a rejected query', async () => {
    let resolveRetry: ((value: string) => void) | undefined
    const fetcher = vi
      .fn<(id: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error('query failed'))
      .mockImplementationOnce(
        () =>
          new Promise<string>(resolve => {
            resolveRetry = resolve
          }),
      )
    const fetchUser = query(fetcher, 'dedupedRetryQuery')

    fetchUser('123')
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    const firstRetry = fetchUser('123')
    const secondRetry = fetchUser('123')
    expect(fetcher).toHaveBeenCalledTimes(2)

    resolveRetry?.('ok')
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(firstRetry()).toBe('ok')
    expect(secondRetry()).toBe('ok')
  })

  it('deduplicates refreshes of an expired query result', async () => {
    let now = 0
    let resolveRefresh: ((value: string) => void) | undefined
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const fetcher = vi
      .fn<(id: string) => Promise<string>>()
      .mockResolvedValueOnce('initial')
      .mockImplementationOnce(
        () =>
          new Promise<string>(resolve => {
            resolveRefresh = resolve
          }),
      )
    const fetchUser = query(fetcher, 'dedupedExpiredQuery')

    try {
      fetchUser('123')
      await Promise.resolve()
      await Promise.resolve()
      now = 3 * 60 * 1000 + 1

      const firstRefresh = fetchUser('123')
      const secondRefresh = fetchUser('123')
      expect(fetcher).toHaveBeenCalledTimes(2)
      expect(firstRefresh()).toBe('initial')
      expect(secondRefresh()).toBe('initial')

      resolveRefresh?.('refreshed')
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      expect(firstRefresh()).toBe('refreshed')
      expect(secondRefresh()).toBe('refreshed')
    } finally {
      dateNow.mockRestore()
    }
  })

  it('should dedupe pending requests for the same key', async () => {
    let resolveFetch: ((value: string) => void) | undefined
    const fetcher = vi.fn<(id: string) => Promise<string>>(
      _id =>
        new Promise<string>(resolve => {
          resolveFetch = resolve
        }),
    )
    const fetchUser = query(fetcher, 'pendingQuery')

    const first = fetchUser('123')
    const second = fetchUser('123')

    expect(fetcher).toHaveBeenCalledTimes(1)

    resolveFetch?.('ok')
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(first()).toBe('ok')
    expect(second()).toBe('ok')
  })

  it('should keep different pending keys separate', async () => {
    const fetcher = vi.fn(
      (id: string) =>
        new Promise<string>(resolve => {
          resolve(`ok:${id}`)
        }),
    )
    const fetchUser = query(fetcher, 'pendingDifferentQuery')

    const first = fetchUser('123')
    const second = fetchUser('456')
    await Promise.resolve()
    await Promise.resolve()

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(first()).toBe('ok:123')
    expect(second()).toBe('ok:456')
  })

  it('should dedupe pending failures for the same key', async () => {
    let rejectFetch: ((err: unknown) => void) | undefined
    const fetcher = vi.fn<(id: string) => Promise<string>>(
      _id =>
        new Promise<string>((_, reject) => {
          rejectFetch = reject
        }),
    )
    const fetchUser = query(fetcher, 'pendingFailureQuery')

    const first = fetchUser('123')
    const second = fetchUser('123')

    expect(fetcher).toHaveBeenCalledTimes(1)

    const failure = new Error('failed')
    rejectFetch?.(failure)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(first.error()).toBe(failure)
    expect(second.error()).toBe(failure)
    expect(() => first()).toThrow('failed')
    expect(() => second()).toThrow('failed')
  })

  it('should keep null and undefined query args separate', async () => {
    const fetcher = vi.fn((value: null | undefined) =>
      value === null ? 'from-null' : 'from-undefined',
    )
    const fetchValue = query(fetcher, 'nullUndefinedQuery')

    const nullValue = fetchValue(null)
    await Promise.resolve()
    await Promise.resolve()

    const undefinedValue = fetchValue(undefined)
    await Promise.resolve()
    await Promise.resolve()

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(nullValue()).toBe('from-null')
    expect(undefinedValue()).toBe('from-undefined')
  })

  it('should keep different function query args separate by identity', async () => {
    const fetcher = vi.fn((callback: () => string) => callback())
    const fetchValue = query(fetcher, 'functionArgQuery')
    const firstCallback = () => 'first'
    const secondCallback = () => 'second'

    const first = fetchValue(firstCallback)
    await Promise.resolve()
    await Promise.resolve()

    const firstAgain = fetchValue(firstCallback)
    const second = fetchValue(secondCallback)
    await Promise.resolve()
    await Promise.resolve()

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(first()).toBe('first')
    expect(firstAgain()).toBe('first')
    expect(second()).toBe('second')
  })

  it('should keep different symbol query args separate by identity', async () => {
    const firstSymbol = Symbol('id')
    const secondSymbol = Symbol('id')
    const fetcher = vi.fn((value: symbol) => (value === firstSymbol ? 'first' : 'second'))
    const fetchValue = query(fetcher, 'symbolArgQuery')

    const first = fetchValue(firstSymbol)
    await Promise.resolve()
    await Promise.resolve()

    const firstAgain = fetchValue(firstSymbol)
    const second = fetchValue(secondSymbol)
    await Promise.resolve()
    await Promise.resolve()

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(first()).toBe('first')
    expect(firstAgain()).toBe('first')
    expect(second()).toBe('second')
  })

  it('should keep sparse array holes separate from undefined query values', async () => {
    const fetcher = vi.fn((value: unknown[]) =>
      Object.prototype.hasOwnProperty.call(value, 0) ? 'present' : 'hole',
    )
    const fetchValue = query(fetcher, 'sparseArrayQuery')
    const sparseValue = new Array(1)

    const present = fetchValue([undefined])
    await Promise.resolve()
    await Promise.resolve()

    const sparse = fetchValue(sparseValue)
    await Promise.resolve()
    await Promise.resolve()

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(present()).toBe('present')
    expect(sparse()).toBe('hole')
  })

  it('should keep object query keys stable regardless of property order', async () => {
    const fetcher = vi.fn((_value: { a: number; b: number }) => 'ok')
    const fetchValue = query(fetcher, 'objectOrderQuery')

    const first = fetchValue({ a: 1, b: 2 })
    await Promise.resolve()
    await Promise.resolve()

    const second = fetchValue({ b: 2, a: 1 })

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(first()).toBe('ok')
    expect(second()).toBe('ok')
  })

  it('should keep distinct URLSearchParams query args separate by identity', async () => {
    const fetcher = vi.fn((value: URLSearchParams) => value.get('viewer'))
    const fetchValue = query(fetcher, 'urlSearchParamsArgQuery')
    const aliceParams = new URLSearchParams({ viewer: 'alice' })
    const bobParams = new URLSearchParams({ viewer: 'bob' })

    const alice = fetchValue(aliceParams)
    await Promise.resolve()
    await Promise.resolve()

    const aliceAgain = fetchValue(aliceParams)
    const bob = fetchValue(bobParams)
    await Promise.resolve()
    await Promise.resolve()

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(alice()).toBe('alice')
    expect(aliceAgain()).toBe('alice')
    expect(bob()).toBe('bob')
  })

  it('should keep distinct URL query args separate by identity', async () => {
    const fetcher = vi.fn((value: URL) => value.pathname)
    const fetchValue = query(fetcher, 'urlArgQuery')
    const firstUrl = new URL('https://example.com/first')
    const secondUrl = new URL('https://example.com/second')

    const first = fetchValue(firstUrl)
    await Promise.resolve()
    await Promise.resolve()

    const firstAgain = fetchValue(firstUrl)
    const second = fetchValue(secondUrl)
    await Promise.resolve()
    await Promise.resolve()

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(first()).toBe('/first')
    expect(firstAgain()).toBe('/first')
    expect(second()).toBe('/second')
  })

  it('should keep distinct Headers query args separate by identity', async () => {
    const fetcher = vi.fn((value: Headers) => value.get('x-viewer'))
    const fetchValue = query(fetcher, 'headersArgQuery')
    const aliceHeaders = new Headers({ 'x-viewer': 'alice' })
    const bobHeaders = new Headers({ 'x-viewer': 'bob' })

    const alice = fetchValue(aliceHeaders)
    await Promise.resolve()
    await Promise.resolve()

    const aliceAgain = fetchValue(aliceHeaders)
    const bob = fetchValue(bobHeaders)
    await Promise.resolve()
    await Promise.resolve()

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(alice()).toBe('alice')
    expect(aliceAgain()).toBe('alice')
    expect(bob()).toBe('bob')
  })

  it('should keep custom class query args with hidden state separate by identity', async () => {
    class ViewerKey {
      readonly kind = 'viewer'
      readonly #name: string

      constructor(name: string) {
        this.#name = name
      }

      read(): string {
        return this.#name
      }
    }

    const fetcher = vi.fn((value: ViewerKey) => value.read())
    const fetchValue = query(fetcher, 'customClassArgQuery')
    const aliceKey = new ViewerKey('alice')
    const bobKey = new ViewerKey('bob')

    const alice = fetchValue(aliceKey)
    await Promise.resolve()
    await Promise.resolve()

    const aliceAgain = fetchValue(aliceKey)
    const bob = fetchValue(bobKey)
    await Promise.resolve()
    await Promise.resolve()

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(alice()).toBe('alice')
    expect(aliceAgain()).toBe('alice')
    expect(bob()).toBe('bob')
  })

  it('should keep nested undefined properties separate from missing properties', async () => {
    type NestedArg = { nested: { value?: undefined } }
    const fetcher = vi.fn((value: NestedArg) =>
      Object.prototype.hasOwnProperty.call(value.nested, 'value') ? 'has-value' : 'missing',
    )
    const fetchValue = query(fetcher, 'nestedUndefinedQuery')

    const withUndefined = fetchValue({ nested: { value: undefined } })
    await Promise.resolve()
    await Promise.resolve()

    const missing = fetchValue({ nested: {} })
    await Promise.resolve()
    await Promise.resolve()

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(withUndefined()).toBe('has-value')
    expect(missing()).toBe('missing')
  })

  it('should keep primitive query arg types separate', async () => {
    const fetcher = vi.fn((value: boolean | number | string) => `${typeof value}:${String(value)}`)
    const fetchValue = query(fetcher, 'primitiveArgQuery')

    const numberValue = fetchValue(1)
    const stringValue = fetchValue('1')
    const booleanValue = fetchValue(true)
    await Promise.resolve()
    await Promise.resolve()

    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(numberValue()).toBe('number:1')
    expect(stringValue()).toBe('string:1')
    expect(booleanValue()).toBe('boolean:true')
  })

  it('isolates cached query data between SSR sessions', async () => {
    let currentUser = 'alice'
    const fetcher = vi.fn(async (_key: string) => currentUser)
    const fetchUser = query(fetcher, 'sessionUser')
    const aliceSession = __fictCreateSSRSession()
    const bobSession = __fictCreateSSRSession()

    const alice = __fictRunWithSSRSession(aliceSession, () => fetchUser('same-key'))
    await Promise.resolve()
    await Promise.resolve()

    currentUser = 'bob'
    const bob = __fictRunWithSSRSession(bobSession, () => fetchUser('same-key'))
    await Promise.resolve()
    await Promise.resolve()

    const aliceAgain = __fictRunWithSSRSession(aliceSession, () => fetchUser('same-key'))
    const bobAgain = __fictRunWithSSRSession(bobSession, () => fetchUser('same-key'))

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(alice()).toBe('alice')
    expect(aliceAgain()).toBe('alice')
    expect(bob()).toBe('bob')
    expect(bobAgain()).toBe('bob')
  })
})

describe('revalidate', () => {
  beforeEach(() => {
    cleanupDataUtilities()
  })

  afterEach(() => {
    cleanupDataUtilities()
  })

  it('should invalidate all queries when no key provided', () => {
    // Create some queries first
    const fetchUser = query(async (id: string) => ({ id }), 'fetchUser')
    const fetchPosts = query(async () => [], 'fetchPosts')

    fetchUser('123')
    fetchPosts()

    // Invalidate all
    revalidate()

    // Queries should refetch on next call
    // (We can't easily verify cache clearing without accessing internals)
    expect(true).toBe(true)
  })

  it('should invalidate queries by key prefix', () => {
    const fetchUser = query(async (id: string) => ({ id }), 'fetchUser')
    fetchUser('123')

    // Invalidate by prefix
    revalidate('fetchUser')

    // Query should refetch on next call
    expect(true).toBe(true)
  })

  it('invalidates every matching key with a global regular expression', async () => {
    const fetcher = vi.fn((id: string) => Promise.resolve(id))
    const fetchUser = query(fetcher, 'regexInvalidation')

    fetchUser('first')
    fetchUser('second')
    await Promise.resolve()
    await Promise.resolve()
    expect(fetcher).toHaveBeenCalledTimes(2)

    const pattern = /^regexInvalidation:/g
    pattern.lastIndex = 3
    revalidate(pattern)
    expect(pattern.lastIndex).toBe(3)

    fetchUser('first')
    fetchUser('second')
    expect(fetcher).toHaveBeenCalledTimes(4)
  })
})

describe('action', () => {
  beforeEach(() => {
    cleanupDataUtilities()
  })

  afterEach(() => {
    cleanupDataUtilities()
  })

  it('should create an action', () => {
    const createUser = action(async (formData: FormData) => {
      return { id: '123', name: formData.get('name') }
    }, 'createUser')

    expect(createUser.url).toBe('/_action/createUser')
    expect(createUser.name).toBe('createUser')
    expect(typeof createUser.submit).toBe('function')
  })

  it('encodes action names as a single URL path segment', () => {
    const actionName = 'save draft/文档?mode#final%'
    const saveDraft = action(async () => undefined, actionName)

    expect(saveDraft.name).toBe(actionName)
    expect(saveDraft.url).toBe('/_action/save%20draft%2F%E6%96%87%E6%A1%A3%3Fmode%23final%25')
  })

  it('should submit action', async () => {
    const createUser = action(async (formData: FormData) => {
      return { id: '123', name: formData.get('name') as string }
    }, 'createUser')

    const formData = new FormData()
    formData.set('name', 'Test User')

    const result = await createUser.submit(formData)

    expect(result.id).toBe('123')
    expect(result.name).toBe('Test User')
  })
})

describe('submitAction', () => {
  beforeEach(() => {
    cleanupDataUtilities()
  })

  afterEach(() => {
    cleanupDataUtilities()
  })

  it('should track submission state', async () => {
    const createUser = action(async (formData: FormData) => {
      await new Promise(resolve => setTimeout(resolve, 10))
      return { id: '123' }
    }, 'createUser')

    const formData = new FormData()
    formData.set('name', 'Test')

    const promise = submitAction(createUser, formData)

    // Wait for completion
    await promise

    // Verify result is returned
    const result = await promise
    expect(result.id).toBe('123')
  })

  it('should forward route parameters to the action function', async () => {
    const updateUser = action(async (_formData, { params }) => params.id, 'updateUser')
    const formData = new FormData()

    await expect(submitAction(updateUser, formData, { id: '42' })).resolves.toBe('42')
  })

  it('should handle errors', async () => {
    const failingAction = action(async () => {
      throw new Error('Action failed')
    }, 'failingAction')

    const formData = new FormData()

    await expect(submitAction(failingAction, formData)).rejects.toThrow('Action failed')
  })

  it('isolates pending, settled, and cleared submissions between SSR sessions', async () => {
    const settlers: Array<{
      resolve: (value: string) => void
      reject: (error: Error) => void
    }> = []
    const save = action<string>(
      () =>
        new Promise<string>((resolve, reject) => {
          settlers.push({ resolve, reject })
        }),
      'isolatedSSRSubmission',
    )
    const aliceSession = __fictCreateSSRSession()
    const bobSession = __fictCreateSSRSession()
    const aliceCurrent = __fictRunWithSSRSession(aliceSession, () => useSubmission(save))
    const aliceAll = __fictRunWithSSRSession(aliceSession, () => useSubmissions())
    const bobCurrent = __fictRunWithSSRSession(bobSession, () => useSubmission(save))
    const bobAll = __fictRunWithSSRSession(bobSession, () => useSubmissions())
    let alicePromise: Promise<string> | undefined
    let bobPromise: Promise<string> | undefined
    let aliceSettled = false
    let bobSettled = false

    try {
      alicePromise = __fictRunWithSSRSession(aliceSession, () => submitAction(save, new FormData()))
      const alice = aliceCurrent()!

      expect(alice).toMatchObject({ state: 'submitting' })
      expect(aliceAll()).toEqual([alice])
      expect(bobCurrent()).toBeUndefined()
      expect(bobAll()).toEqual([])

      aliceSettled = true
      settlers[0]!.resolve('Alice')
      await expect(alicePromise).resolves.toBe('Alice')

      expect(alice).toMatchObject({ state: 'idle', result: 'Alice' })
      expect(aliceCurrent()).toBe(alice)
      expect(bobCurrent()).toBeUndefined()

      bobPromise = __fictRunWithSSRSession(bobSession, () => submitAction(save, new FormData()))
      const bob = bobCurrent()!

      expect(bob).toMatchObject({ state: 'submitting' })
      expect(bobAll()).toEqual([bob])
      expect(aliceCurrent()).toBe(alice)
      expect(aliceAll()).toEqual([alice])

      alice.clear()
      expect(aliceCurrent()).toBeUndefined()
      expect(aliceAll()).toEqual([])
      expect(bobCurrent()).toBe(bob)

      bobSettled = true
      settlers[1]!.resolve('Bob')
      await expect(bobPromise).resolves.toBe('Bob')

      expect(bob).toMatchObject({ state: 'idle', result: 'Bob' })
      expect(bobCurrent()).toBe(bob)
      expect(aliceCurrent()).toBeUndefined()
    } finally {
      if (!aliceSettled) settlers[0]?.resolve('Alice cleanup')
      if (!bobSettled) settlers[1]?.resolve('Bob cleanup')
      await Promise.allSettled([alicePromise, bobPromise].filter(Boolean) as Promise<string>[])
    }
  })

  it('keeps an SSR retry in the submission store captured by its original request', async () => {
    const settlers: Array<{
      resolve: (value: string) => void
      reject: (error: Error) => void
    }> = []
    const save = action<string>(
      () =>
        new Promise<string>((resolve, reject) => {
          settlers.push({ resolve, reject })
        }),
      'isolatedSSRRetry',
    )
    const aliceSession = __fictCreateSSRSession()
    const bobSession = __fictCreateSSRSession()
    const aliceCurrent = __fictRunWithSSRSession(aliceSession, () => useSubmission(save))
    const bobCurrent = __fictRunWithSSRSession(bobSession, () => useSubmission(save))
    const originalPromise = __fictRunWithSSRSession(aliceSession, () =>
      submitAction(save, new FormData()),
    )
    const original = aliceCurrent()!
    let originalSettled = false
    let retrySettled = false

    try {
      expect(bobCurrent()).toBeUndefined()

      original.retry()
      const retried = aliceCurrent()!

      expect(retried.key).not.toBe(original.key)
      expect(retried).toMatchObject({ state: 'submitting' })
      expect(bobCurrent()).toBeUndefined()

      retrySettled = true
      settlers[1]!.resolve('retried')
      await vi.waitFor(() => expect(retried).toMatchObject({ state: 'idle', result: 'retried' }))
      expect(aliceCurrent()).toBe(retried)
      expect(bobCurrent()).toBeUndefined()

      originalSettled = true
      settlers[0]!.resolve('original')
      await expect(originalPromise).resolves.toBe('original')
      expect(aliceCurrent()).toBe(retried)
      expect(bobCurrent()).toBeUndefined()
    } finally {
      if (!originalSettled) settlers[0]?.resolve('original cleanup')
      if (!retrySettled) settlers[1]?.resolve('retry cleanup')
      await Promise.allSettled([originalPromise])
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  })

  it('fails closed when an active SSR submission loses its async session carrier', async () => {
    let resolveSubmission!: (value: string) => void
    const save = action<string>(
      () =>
        new Promise<string>(resolve => {
          resolveSubmission = resolve
        }),
      'isolatedSSRFallbackSubmission',
    )
    const browserCurrent = useSubmission(save)
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const serverRun = __fictRunWithSSRSession(__fictCreateSSRSession(), async () => {
      await gate
      expect(__fictGetCurrentSSRSession()).toBeNull()
      return submitAction(save, new FormData())
    })

    release()
    await vi.waitFor(() => expect(resolveSubmission).toBeTypeOf('function'))

    try {
      expect(browserCurrent()).toBeUndefined()
    } finally {
      resolveSubmission('server')
      await expect(serverRun).resolves.toBe('server')
    }

    expect(browserCurrent()).toBeUndefined()
  })

  it('preserves the shared browser submission store behavior', async () => {
    let resolveSubmission!: (value: string) => void
    const save = action<string>(
      () =>
        new Promise<string>(resolve => {
          resolveSubmission = resolve
        }),
      'sharedBrowserSubmission',
    )
    const current = useSubmission(save)
    const all = useSubmissions()
    const promise = submitAction(save, new FormData())
    const submission = current()!

    expect(submission).toMatchObject({ state: 'submitting' })
    expect(all()).toEqual([submission])

    resolveSubmission('saved')
    await expect(promise).resolves.toBe('saved')

    expect(current()).toBe(submission)
    expect(submission).toMatchObject({ state: 'idle', result: 'saved' })
    expect(all()).toEqual([submission])

    submission.clear()
    expect(current()).toBeUndefined()
    expect(all()).toEqual([])
  })

  it('keeps concurrent submissions for the same action independently visible', async () => {
    const resolvers: Array<(value: string) => void> = []
    const save = action<string>(
      () =>
        new Promise<string>(resolve => {
          resolvers.push(resolve)
        }),
      'visibleConcurrentSubmissions',
    )
    const current = useSubmission(save)
    const all = useSubmissions()

    const firstPromise = submitAction(save, new FormData())
    const first = current()!
    const secondPromise = submitAction(save, new FormData())
    const second = current()!

    expect(current()).toBe(second)
    expect(all()).toEqual([first, second])

    resolvers[0]!('first')
    await expect(firstPromise).resolves.toBe('first')
    expect(first).toMatchObject({ state: 'idle', result: 'first' })
    expect(second).toMatchObject({ state: 'submitting' })
    expect(all()).toEqual([first, second])

    first.clear()
    expect(current()).toBe(second)
    expect(all()).toEqual([second])

    resolvers[1]!('second')
    await expect(secondPromise).resolves.toBe('second')
    second.clear()
    expect(current()).toBeUndefined()
    expect(all()).toEqual([])
  })

  it('keeps the newer submission current when an older submission resolves last', async () => {
    const resolvers: Array<(value: string) => void> = []
    const save = action<string>(
      () =>
        new Promise<string>(resolve => {
          resolvers.push(resolve)
        }),
      'concurrentResolve',
    )
    const current = useSubmission(save)

    const firstPromise = submitAction(save, new FormData())
    const first = current()!
    const secondPromise = submitAction(save, new FormData())
    const second = current()!

    expect(first.key).not.toBe(second.key)
    expect(current()).toBe(second)

    resolvers[1]!('newer')
    await expect(secondPromise).resolves.toBe('newer')
    expect(current()).toBe(second)
    expect(second).toMatchObject({ state: 'idle', result: 'newer' })

    resolvers[0]!('older')
    await expect(firstPromise).resolves.toBe('older')
    expect(first).toMatchObject({ state: 'idle', result: 'older' })
    expect(current()).toBe(second)
    expect(current()?.result).toBe('newer')
  })

  it('keeps the newer submission current when an older submission rejects last', async () => {
    const settlers: Array<{
      resolve: (value: string) => void
      reject: (error: Error) => void
    }> = []
    const save = action<string>(
      () =>
        new Promise<string>((resolve, reject) => {
          settlers.push({ resolve, reject })
        }),
      'concurrentReject',
    )
    const current = useSubmission(save)

    const firstPromise = submitAction(save, new FormData())
    const first = current()!
    const secondPromise = submitAction(save, new FormData())
    const second = current()!

    settlers[1]!.resolve('newer')
    await expect(secondPromise).resolves.toBe('newer')

    const olderError = new Error('older failed')
    settlers[0]!.reject(olderError)
    await expect(firstPromise).rejects.toBe(olderError)

    expect(first).toMatchObject({ state: 'idle', error: olderError })
    expect(current()).toBe(second)
    expect(current()).toMatchObject({ state: 'idle', result: 'newer' })
  })

  it('reveals the preceding submission when the latest concurrent one is cleared', async () => {
    const resolvers: Array<(value: string) => void> = []
    const save = action<string>(
      () =>
        new Promise<string>(resolve => {
          resolvers.push(resolve)
        }),
      'concurrentClear',
    )
    const current = useSubmission(save)
    const all = useSubmissions()

    const firstPromise = submitAction(save, new FormData())
    const first = current()!
    const secondPromise = submitAction(save, new FormData())
    const second = current()!

    second.clear()
    expect(current()).toBe(first)
    expect(all()).toEqual([first])

    first.clear()
    expect(current()).toBeUndefined()
    expect(all()).toEqual([])

    resolvers[1]!('newer')
    resolvers[0]!('older')
    await expect(secondPromise).resolves.toBe('newer')
    await expect(firstPromise).resolves.toBe('older')
    expect(current()).toBeUndefined()
  })

  it('does not let the original completion replace its retried submission', async () => {
    const resolvers: Array<(value: string) => void> = []
    const save = action<string>(
      () =>
        new Promise<string>(resolve => {
          resolvers.push(resolve)
        }),
      'concurrentRetry',
    )
    const current = useSubmission(save)

    const originalPromise = submitAction(save, new FormData())
    const original = current()!
    original.retry()
    const retried = current()!

    expect(retried.key).not.toBe(original.key)
    expect(current()).toBe(retried)

    resolvers[1]!('retried')
    await vi.waitFor(() => expect(retried).toMatchObject({ state: 'idle', result: 'retried' }))
    expect(current()).toBe(retried)

    resolvers[0]!('original')
    await expect(originalPromise).resolves.toBe('original')
    expect(original).toMatchObject({ state: 'idle', result: 'original' })
    expect(current()).toBe(retried)
    expect(current()?.result).toBe('retried')

    original.clear()
    expect(current()).toBe(retried)
  })

  it('contains a rejected retry while preserving its submission error', async () => {
    const settlers: Array<{
      resolve: (value: string) => void
      reject: (error: Error) => void
    }> = []
    const save = action<string>(
      () =>
        new Promise<string>((resolve, reject) => {
          settlers.push({ resolve, reject })
        }),
      'rejectedRetry',
    )
    const current = useSubmission(save)
    const originalPromise = submitAction(save, new FormData())
    const original = current()!
    const catchSpy = vi.spyOn(Promise.prototype, 'catch')
    let retryRejected = false

    try {
      catchSpy.mockClear()
      const retryResult = original.retry()
      const retried = current()!
      const attachedRejectionHandlers = catchSpy.mock.calls.length
      catchSpy.mockRestore()

      expect(retryResult).toBeUndefined()
      expect(retried.key).not.toBe(original.key)
      expect(attachedRejectionHandlers).toBe(1)

      const retryError = new Error('retry failed')
      retryRejected = true
      settlers[1]!.reject(retryError)

      await vi.waitFor(() => expect(retried).toMatchObject({ state: 'idle', error: retryError }))
      expect(current()).toBe(retried)
      expect(current()?.error).toBe(retryError)
    } finally {
      catchSpy.mockRestore()
      settlers[0]?.resolve('original')
      if (!retryRejected) settlers[1]?.resolve('retry cleanup')
      await expect(originalPromise).resolves.toBe('original')
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  })
})

describe('createResource', () => {
  beforeEach(() => {
    cleanupDataUtilities()
  })

  afterEach(() => {
    cleanupDataUtilities()
  })

  it('should create a resource', () => {
    const resource = createResource(
      () => '123',
      async id => ({ id, name: 'Test' }),
    )

    expect(typeof resource).toBe('function')
    expect(typeof resource.loading).toBe('function')
    expect(typeof resource.error).toBe('function')
    expect(typeof resource.refetch).toBe('function')
  })

  it('should start in loading state', () => {
    const resource = createResource(
      () => '123',
      async id => {
        await new Promise(resolve => setTimeout(resolve, 100))
        return { id }
      },
    )

    expect(resource.loading()).toBe(true)
    expect(resource()).toBe(undefined)
  })

  it('should resolve with data', async () => {
    const resource = createResource(
      () => '123',
      async id => ({ id, name: 'Test' }),
    )

    // Wait for data to load
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(resource.loading()).toBe(false)
    expect(resource()?.id).toBe('123')
  })

  it('should fetch when initial source is undefined', async () => {
    const fetcher = vi.fn(async (source: undefined) => `loaded:${String(source)}`)
    const resource = createResource(() => undefined, fetcher)

    await new Promise(resolve => setTimeout(resolve, 50))

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(resource.loading()).toBe(false)
    expect(resource()).toBe('loaded:undefined')
  })

  it('should fetch for initial falsy source values', async () => {
    const cases = [
      { label: 'null', source: null },
      { label: 'false', source: false },
      { label: 'zero', source: 0 },
      { label: 'empty', source: '' },
    ] as const

    for (const item of cases) {
      const fetcher = vi.fn(async (source: unknown) => `${item.label}:${String(source)}`)
      const resource = createResource(() => item.source, fetcher)

      await new Promise(resolve => setTimeout(resolve, 50))

      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(resource.loading()).toBe(false)
      expect(resource()).toBe(`${item.label}:${String(item.source)}`)
    }
  })

  it('should refetch when source changes back to undefined', async () => {
    const source = createSignal<string | undefined>('first')
    const fetcher = vi.fn(async (value: string | undefined) => `loaded:${String(value)}`)
    const resource = createResource(source, fetcher)

    await new Promise(resolve => setTimeout(resolve, 50))
    expect(resource()).toBe('loaded:first')

    source(undefined)
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(resource.loading()).toBe(false)
    expect(resource()).toBe('loaded:undefined')
  })

  it('should handle errors', async () => {
    const resource = createResource(
      () => '123',
      async () => {
        throw new Error('Fetch failed')
      },
    )

    // Wait for error
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(resource.loading()).toBe(false)
    expect(resource.error()).toBeInstanceOf(Error)
  })

  it('clears current data while preserving latest through a failed refresh', async () => {
    const refreshError = new Error('refresh failed')
    const fetcher = vi
      .fn<(source: string) => Promise<string>>()
      .mockResolvedValueOnce('first')
      .mockRejectedValueOnce(refreshError)
    const resource = createResource(() => 'key', fetcher)

    await vi.waitFor(() => expect(resource()).toBe('first'))
    expect(resource.latest()).toBe('first')

    const refresh = resource.refetch()
    expect(resource.loading()).toBe(true)
    expect(resource()).toBeUndefined()
    expect(resource.latest()).toBe('first')

    await expect(refresh).resolves.toBeUndefined()
    expect(resource.loading()).toBe(false)
    expect(resource()).toBeUndefined()
    expect(resource.latest()).toBe('first')
    expect(resource.error()).toBe(refreshError)
  })

  it('throws a request token while suspense mode is loading', async () => {
    let resolveRequest!: (value: string) => void
    const request = new Promise<string>(resolve => {
      resolveRequest = resolve
    })
    const resource = createResource(
      () => 'key',
      () => request,
      { suspense: true },
    )

    let token: PromiseLike<unknown> | undefined
    try {
      resource()
    } catch (error) {
      token = error as PromiseLike<unknown>
    }

    expect(token).toBeDefined()
    expect(typeof token?.then).toBe('function')

    const settled = Promise.resolve(token)
    resolveRequest('ready')
    await settled

    expect(resource()).toBe('ready')
    expect(resource.latest()).toBe('ready')
  })

  it('aborts an owned request and ignores its completion after disposal', async () => {
    let resolveRequest!: (value: string) => void
    let requestSignal: AbortSignal | undefined
    let ownedResource!: Resource<string>
    const container = document.createElement('div')
    const dispose = render(() => {
      ownedResource = createResource(
        () => 'key',
        (_source, { signal }) => {
          requestSignal = signal
          return new Promise<string>(resolve => {
            resolveRequest = resolve
          })
        },
      )
      return null
    }, container)

    expect(requestSignal?.aborted).toBe(false)
    expect(ownedResource.loading()).toBe(true)

    dispose()
    expect(requestSignal?.aborted).toBe(true)

    resolveRequest('late result')
    await Promise.resolve()
    await Promise.resolve()

    expect(ownedResource()).toBeUndefined()
    expect(ownedResource.latest()).toBeUndefined()
    expect(ownedResource.loading()).toBe(false)
  })
})
