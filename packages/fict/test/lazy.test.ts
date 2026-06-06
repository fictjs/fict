import { Suspense, render } from '@fictjs/runtime'
import { describe, it, expect, vi } from 'vitest'

import { lazy } from '../src/lazy'

const tick = () => Promise.resolve()

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
})
