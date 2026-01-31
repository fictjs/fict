/**
 * Tests for the act utility function
 *
 * Note: act() is used to wrap code that triggers state updates and effects,
 * ensuring all pending microtasks are flushed before assertions.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, renderHook, cleanup, act, flush } from '../src/index'
import { createElement, createEffect, onMount, onDestroy } from '@fictjs/runtime'
import { createSignal } from '@fictjs/runtime/advanced'

const tick = () =>
  new Promise<void>(resolve =>
    typeof queueMicrotask === 'function'
      ? queueMicrotask(resolve)
      : Promise.resolve().then(resolve),
  )

describe('act', () => {
  beforeEach(() => {
    cleanup()
  })

  describe('synchronous updates', () => {
    it('flushes synchronous state updates in hooks', async () => {
      const { result } = renderHook(() => {
        const count = createSignal(0)
        return { count, increment: () => count(count() + 1) }
      })

      expect(result.current.count()).toBe(0)

      await act(() => {
        result.current.increment()
        result.current.increment()
        result.current.increment()
      })

      expect(result.current.count()).toBe(3)
    })

    it('returns the result of the synchronous function', async () => {
      const result = await act(() => {
        return 42
      })

      expect(result).toBe(42)
    })

    it('returns undefined when function returns nothing', async () => {
      const result = await act(() => {
        // No return
      })

      expect(result).toBeUndefined()
    })

    it('returns complex objects', async () => {
      const result = await act(() => {
        return { foo: 'bar', count: 42 }
      })

      expect(result).toEqual({ foo: 'bar', count: 42 })
    })
  })

  describe('asynchronous updates', () => {
    it('handles async functions', async () => {
      const { result } = renderHook(() => {
        const data = createSignal<string | null>(null)
        return { data, setData: (v: string) => data(v) }
      })

      expect(result.current.data()).toBeNull()

      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 10))
        result.current.setData('Loaded')
      })

      expect(result.current.data()).toBe('Loaded')
    })

    it('returns the result of async function', async () => {
      const result = await act(async () => {
        await tick()
        return 'async result'
      })

      expect(result).toBe('async result')
    })

    it('handles multiple async updates', async () => {
      const { result } = renderHook(() => {
        const items = createSignal<string[]>([])
        return { items, push: (item: string) => items([...items(), item]) }
      })

      await act(async () => {
        result.current.push('a')
        await tick()
        result.current.push('b')
        await tick()
        result.current.push('c')
      })

      expect(result.current.items()).toEqual(['a', 'b', 'c'])
    })
  })

  describe('error handling', () => {
    it('propagates synchronous errors', async () => {
      await expect(
        act(() => {
          throw new Error('Sync error')
        }),
      ).rejects.toThrow('Sync error')
    })

    it('propagates async errors', async () => {
      await expect(
        act(async () => {
          await tick()
          throw new Error('Async error')
        }),
      ).rejects.toThrow('Async error')
    })

    it('still flushes on error', async () => {
      let flushed = false

      queueMicrotask(() => {
        flushed = true
      })

      try {
        await act(() => {
          throw new Error('Test error')
        })
      } catch (e) {
        // Expected
      }

      // Microtasks should still be flushed
      expect(flushed).toBe(true)
    })
  })

  describe('nested act calls', () => {
    it('handles nested act calls', async () => {
      const { result } = renderHook(() => {
        const outer = createSignal(0)
        const inner = createSignal(0)
        return { outer, inner }
      })

      await act(async () => {
        result.current.outer(1)
        await act(async () => {
          result.current.inner(1)
        })
        result.current.outer(2)
      })

      expect(result.current.outer()).toBe(2)
      expect(result.current.inner()).toBe(1)
    })
  })

  describe('with effects', () => {
    it('waits for effects to complete', async () => {
      const effectResults: number[] = []

      const { result } = renderHook(() => {
        const trigger = createSignal(0)
        createEffect(() => {
          effectResults.push(trigger())
        })
        return { trigger }
      })

      await act(() => {
        result.current.trigger(1)
      })

      expect(effectResults).toContain(0)
      expect(effectResults).toContain(1)
    })

    it('handles effects that update other signals', async () => {
      const log: string[] = []

      const { result } = renderHook(() => {
        const primary = createSignal(0)
        const secondary = createSignal(0)

        createEffect(() => {
          const p = primary()
          log.push(`primary: ${p}`)
          if (p > 0) {
            secondary(p * 10)
          }
        })

        createEffect(() => {
          log.push(`secondary: ${secondary()}`)
        })

        return { primary, secondary }
      })

      log.length = 0

      await act(() => {
        result.current.primary(1)
      })

      expect(log).toContain('primary: 1')
      expect(log).toContain('secondary: 10')
    })
  })

  describe('timing', () => {
    it('flushes microtasks twice for nested scheduling', async () => {
      const log: number[] = []

      await act(() => {
        queueMicrotask(() => {
          log.push(1)
          queueMicrotask(() => {
            log.push(2)
          })
        })
      })

      // Both microtasks should be flushed due to double flush in act()
      expect(log).toContain(1)
      expect(log).toContain(2)
    })

    it('handles promises that schedule more promises', async () => {
      const log: string[] = []

      await act(async () => {
        log.push('start')
        await Promise.resolve().then(() => {
          log.push('first')
        })
        await Promise.resolve().then(() => {
          log.push('second')
        })
        log.push('end')
      })

      expect(log).toEqual(['start', 'first', 'second', 'end'])
    })
  })

  describe('with lifecycle hooks', () => {
    it('ensures onMount is called within act', async () => {
      let mounted = false

      await act(() => {
        renderHook(() => {
          onMount(() => {
            mounted = true
          })
          return {}
        })
      })

      expect(mounted).toBe(true)
    })
  })
})
