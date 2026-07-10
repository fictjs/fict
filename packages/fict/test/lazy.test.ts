import { Suspense, render } from '@fictjs/runtime'
import { describe, it, expect, vi } from 'vitest'

import { lazy } from '../src/lazy'

const tick = () => Promise.resolve()
const flushPromises = async () => {
  await tick()
  await tick()
}

describe('lazy', () => {
  it('suspends while loading and renders when ready', async () => {
    let resolveModule: ((m: { default: () => any }) => void) | undefined
    const loader = vi.fn(
      () =>
        new Promise<{ default: () => any }>(resolve => {
          resolveModule = resolve
        }),
    )

    const LazyComp = lazy(loader)
    const container = document.createElement('div')

    const dispose = render(
      () => ({
        type: Suspense as any,
        props: {
          fallback: 'loading',
          children: { type: LazyComp, props: {} },
        },
      }),
      container,
    )

    await tick()
    expect(container.textContent).toBe('loading')

    resolveModule?.({ default: () => ({ type: 'span', props: { children: 'ready' } }) })
    await tick()
    await tick()

    expect(container.textContent).toBe('ready')
    dispose()
  })

  it('rejects preload when the loader fails', async () => {
    const error = new Error('load failed')
    const loader = vi.fn(() => Promise.reject(error))
    const LazyComp = lazy(loader)

    await expect(LazyComp.preload()).rejects.toBe(error)
    expect(() => LazyComp({})).toThrow(error)
  })

  it.each([undefined, null, false, 0, ''])(
    'caches a falsy loader rejection until reset: %j',
    async reason => {
      const loader = vi.fn(() => Promise.reject(reason))
      const LazyComp = lazy(loader)

      await expect(LazyComp.preload()).rejects.toBe(reason)

      const notThrown = Symbol('not thrown')
      let thrown: unknown = notThrown
      try {
        LazyComp({})
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBe(reason)
      await expect(LazyComp.preload()).rejects.toBe(reason)
      expect(loader).toHaveBeenCalledTimes(1)

      LazyComp.reset()
      await expect(LazyComp.preload()).rejects.toBe(reason)
      expect(loader).toHaveBeenCalledTimes(2)
    },
  )

  it('normalizes synchronous loader failures into rejected preloads', async () => {
    const error = new Error('sync load failed')
    const loader = vi.fn(() => {
      throw error
    })
    const LazyComp = lazy(loader as never)

    let preload: Promise<void> | undefined
    expect(() => {
      preload = LazyComp.preload()
    }).not.toThrow()
    await expect(preload).rejects.toBe(error)
    expect(() => LazyComp({})).toThrow(error)
  })

  it('rejects modules without a default component', async () => {
    const loader = vi.fn(() => Promise.resolve({ default: undefined }))
    const LazyComp = lazy(loader as never)

    await expect(LazyComp.preload()).rejects.toThrow(/default component/)
    expect(loader).toHaveBeenCalledTimes(1)
    expect(() => LazyComp({})).toThrow(/default component/)
  })

  it('resolves preload after a retry succeeds', async () => {
    const Loaded = () => 'ready'
    const loader = vi
      .fn<() => Promise<{ default: () => string }>>()
      .mockRejectedValueOnce(new Error('first attempt'))
      .mockResolvedValueOnce({ default: Loaded })
    const LazyComp = lazy(loader, { maxRetries: 1, retryDelay: 0 })

    await expect(LazyComp.preload()).resolves.toBeUndefined()

    expect(loader).toHaveBeenCalledTimes(2)
    expect(LazyComp({})).toBe('ready')
  })

  it('rejects preload after retries are exhausted', async () => {
    const first = new Error('first attempt')
    const final = new Error('final attempt')
    const loader = vi
      .fn<() => Promise<{ default: () => string }>>()
      .mockRejectedValueOnce(first)
      .mockRejectedValueOnce(final)
    const LazyComp = lazy(loader, { maxRetries: 1, retryDelay: 0 })

    await expect(LazyComp.preload()).rejects.toBe(final)

    expect(loader).toHaveBeenCalledTimes(2)
    expect(() => LazyComp({})).toThrow(final)
  })

  it('can reset after a preload failure and preload again', async () => {
    const error = new Error('load failed')
    const Loaded = () => 'ready'
    const loader = vi
      .fn<() => Promise<{ default: () => string }>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ default: Loaded })
    const LazyComp = lazy(loader)

    await expect(LazyComp.preload()).rejects.toBe(error)

    LazyComp.reset()
    await expect(LazyComp.preload()).resolves.toBeUndefined()

    expect(loader).toHaveBeenCalledTimes(2)
    expect(LazyComp({})).toBe('ready')
  })

  it('suspends render against an in-flight preload', async () => {
    let resolveModule: ((m: { default: () => any }) => void) | undefined
    const loader = vi.fn(
      () =>
        new Promise<{ default: () => any }>(resolve => {
          resolveModule = resolve
        }),
    )
    const LazyComp = lazy(loader)
    const preloadPromise = LazyComp.preload()
    const container = document.createElement('div')

    const dispose = render(
      () => ({
        type: Suspense as any,
        props: {
          fallback: 'loading',
          children: { type: LazyComp, props: {} },
        },
      }),
      container,
    )

    await tick()
    expect(container.textContent).toBe('loading')

    resolveModule?.({ default: () => ({ type: 'span', props: { children: 'ready' } }) })
    await preloadPromise
    await tick()
    await tick()

    expect(container.textContent).toBe('ready')
    dispose()
  })

  it('ignores stale pending success after reset and newer success', async () => {
    type TestModule = { default: () => string }
    const pending: Array<{
      resolve: (module: TestModule) => void
      reject: (err: unknown) => void
    }> = []
    const loader = vi.fn(
      () =>
        new Promise<TestModule>((resolve, reject) => {
          pending.push({ resolve, reject })
        }),
    )
    const LazyComp = lazy(loader)

    try {
      LazyComp({})
    } catch {}
    LazyComp.reset()
    try {
      LazyComp({})
    } catch {}

    pending[1]!.resolve({ default: () => 'new' })
    await flushPromises()
    expect(LazyComp({})).toBe('new')

    pending[0]!.resolve({ default: () => 'old' })
    await flushPromises()

    expect(LazyComp({})).toBe('new')
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it('restarts a rendered suspense load after reset', async () => {
    type TestModule = { default: () => string }
    const pending: Array<{
      resolve: (module: TestModule) => void
      reject: (err: unknown) => void
    }> = []
    const loader = vi.fn(
      () =>
        new Promise<TestModule>((resolve, reject) => {
          pending.push({ resolve, reject })
        }),
    )
    const LazyComp = lazy(loader)
    const container = document.createElement('div')
    const dispose = render(
      () => ({
        type: Suspense as any,
        props: {
          fallback: 'loading',
          children: { type: LazyComp, props: {} },
        },
      }),
      container,
    )

    await flushPromises()
    expect(container.textContent).toBe('loading')
    expect(loader).toHaveBeenCalledTimes(1)

    LazyComp.reset()
    await flushPromises()
    expect(loader).toHaveBeenCalledTimes(2)

    pending[1]!.resolve({ default: () => 'ready' })
    await flushPromises()
    expect(container.textContent).toBe('ready')

    pending[0]!.resolve({ default: () => 'stale' })
    await flushPromises()
    expect(container.textContent).toBe('ready')
    dispose()
  })

  it('ignores stale pending failure after reset and newer success', async () => {
    type TestModule = { default: () => string }
    const pending: Array<{
      resolve: (module: TestModule) => void
      reject: (err: unknown) => void
    }> = []
    const loader = vi.fn(
      () =>
        new Promise<TestModule>((resolve, reject) => {
          pending.push({ resolve, reject })
        }),
    )
    const LazyComp = lazy(loader)

    try {
      LazyComp({})
    } catch {}
    LazyComp.reset()
    try {
      LazyComp({})
    } catch {}

    pending[1]!.resolve({ default: () => 'new' })
    await flushPromises()
    expect(LazyComp({})).toBe('new')

    pending[0]!.reject(new Error('old failed'))
    await flushPromises()

    expect(LazyComp({})).toBe('new')
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it('ignores stale preload success after reset and render load success', async () => {
    type TestModule = { default: () => string }
    const pending: Array<{
      resolve: (module: TestModule) => void
      reject: (err: unknown) => void
    }> = []
    const loader = vi.fn(
      () =>
        new Promise<TestModule>((resolve, reject) => {
          pending.push({ resolve, reject })
        }),
    )
    const LazyComp = lazy(loader)
    const stalePreload = LazyComp.preload()

    LazyComp.reset()
    try {
      LazyComp({})
    } catch {}

    pending[1]!.resolve({ default: () => 'render' })
    await flushPromises()
    expect(LazyComp({})).toBe('render')

    pending[0]!.resolve({ default: () => 'preload' })
    await stalePreload
    await flushPromises()

    expect(LazyComp({})).toBe('render')
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it('does not let stale retry chains cross reset', async () => {
    vi.useFakeTimers()
    try {
      type TestModule = { default: () => string }
      const pending: Array<{
        resolve: (module: TestModule) => void
        reject: (err: unknown) => void
      }> = []
      const loader = vi.fn(
        () =>
          new Promise<TestModule>((resolve, reject) => {
            pending.push({ resolve, reject })
          }),
      )
      const LazyComp = lazy(loader, { maxRetries: 1, retryDelay: 10 })
      const stalePreload = LazyComp.preload().catch(() => undefined)

      expect(loader).toHaveBeenCalledTimes(1)
      pending[0]!.reject(new Error('first failed'))
      await tick()

      LazyComp.reset()
      const currentPreload = LazyComp.preload()

      expect(loader).toHaveBeenCalledTimes(2)
      pending[1]!.resolve({ default: () => 'new' })
      await currentPreload
      await vi.runAllTimersAsync()
      await stalePreload

      expect(loader).toHaveBeenCalledTimes(2)
      expect(LazyComp({})).toBe('new')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps an already loaded component across reset', async () => {
    const Loaded = () => 'ready'
    const loader = vi.fn<() => Promise<{ default: () => string }>>().mockResolvedValue({
      default: Loaded,
    })
    const LazyComp = lazy(loader)

    await LazyComp.preload()
    LazyComp.reset()

    expect(LazyComp({})).toBe('ready')
    expect(loader).toHaveBeenCalledTimes(1)
  })
})
