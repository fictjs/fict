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

  it('should abort previous request', async () => {
    const abortSpy = vi.fn()
    const fetcher = vi.fn(({ signal }) => {
      signal.addEventListener('abort', abortSpy)
      return new Promise(resolve => setTimeout(() => resolve('done'), 100))
    })

    const r = resource(fetcher)
    const arg = createSignal(1)

    createRoot(() => {
      r.read(arg)
    })

    // Start first request
    arg(2) // Trigger second request immediately
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
})
