import { createSignal, createRoot } from 'fict-runtime'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { resource } from '../resource'

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
    expect(result.loading).toBe(true)

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

    expect(abortSpy).toHaveBeenCalled()
  })
})
