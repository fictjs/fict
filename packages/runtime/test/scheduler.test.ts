import { describe, it, expect, vi } from 'vitest'

import { createEffect, batch } from '../src/index'
import { createSignal } from '../src/advanced'
import { startTransition, useTransition, useDeferredValue } from '../src/scheduler'

const tick = () =>
  new Promise<void>(resolve =>
    typeof queueMicrotask === 'function'
      ? queueMicrotask(resolve)
      : Promise.resolve().then(resolve),
  )

describe('Multi-Priority Scheduler', () => {
  describe('Priority Queue', () => {
    it('high priority tasks execute before low priority', async () => {
      const order: string[] = []
      const count = createSignal(0)

      createEffect(() => {
        count()
        order.push('effect')
      })

      // Clear initial effect run
      order.length = 0

      // Start a transition (low priority)
      startTransition(() => {
        count(1)
        order.push('transition-triggered')
      })

      // Immediately trigger high priority
      count(2)
      order.push('high-triggered')

      await tick()
      await tick()

      // Effect should have run twice (once for high, once for low)
      // High priority update (count=2) should execute first
      expect(order).toContain('transition-triggered')
      expect(order).toContain('high-triggered')
    })

    it('low priority effects are queued separately', async () => {
      const highSignal = createSignal(0)
      const lowSignal = createSignal(0)
      const runs: { type: string; value: number }[] = []

      createEffect(() => {
        runs.push({ type: 'high', value: highSignal() })
      })

      createEffect(() => {
        runs.push({ type: 'low', value: lowSignal() })
      })

      // Clear initial runs
      runs.length = 0

      // Trigger low priority update
      startTransition(() => {
        lowSignal(1)
      })

      // Trigger high priority update
      highSignal(1)

      await tick()
      await tick()

      // Both effects should have run
      expect(runs.some(r => r.type === 'high' && r.value === 1)).toBe(true)
      expect(runs.some(r => r.type === 'low' && r.value === 1)).toBe(true)
    })

    it('promotes low-queued effects after a high-priority write', async () => {
      const lowOnly = createSignal(0)
      const shared = createSignal(0)
      const order: string[] = []

      createEffect(() => {
        order.push(`low:${lowOnly()}`)
      })

      createEffect(() => {
        order.push(`shared:${shared()}`)
      })

      order.length = 0

      startTransition(() => {
        lowOnly(1)
        shared(1)
      })

      shared(2)

      await tick()
      await tick()

      expect(order[0]).toBe('shared:2')
      expect(order).toContain('low:1')
      expect(order.filter(item => item.startsWith('shared:'))).toEqual(['shared:2'])
    })

    it('promotes all shared subscribers without promoting unrelated low work', async () => {
      const lowOnly = createSignal(0)
      const shared = createSignal(0)
      const order: string[] = []

      createEffect(() => {
        order.push(`low:${lowOnly()}`)
      })

      createEffect(() => {
        order.push(`shared-a:${shared()}`)
      })

      createEffect(() => {
        order.push(`shared-b:${shared()}`)
      })

      order.length = 0

      startTransition(() => {
        lowOnly(1)
        shared(1)
      })

      shared(2)

      await tick()
      await tick()

      expect(order.slice(0, 2).sort()).toEqual(['shared-a:2', 'shared-b:2'])
      expect(order[2]).toBe('low:1')
    })

    it('keeps transition-only work in the low-priority queue', async () => {
      const lowA = createSignal(0)
      const lowB = createSignal(0)
      const high = createSignal(0)
      const order: string[] = []

      createEffect(() => {
        order.push(`low-a:${lowA()}`)
      })

      createEffect(() => {
        order.push(`low-b:${lowB()}`)
      })

      createEffect(() => {
        order.push(`high:${high()}`)
      })

      order.length = 0

      startTransition(() => {
        lowA(1)
        lowB(1)
      })

      high(1)

      await tick()
      await tick()

      expect(order[0]).toBe('high:1')
      expect(order.slice(1).sort()).toEqual(['low-a:1', 'low-b:1'])
    })

    it('schedules high-priority work queued by the final low-priority effect', async () => {
      const low = createSignal(0)
      const high = createSignal(0)
      const order: string[] = []

      createEffect(() => {
        if (low() !== 1) return
        order.push('low:start')
        batch(() => high(1))
        order.push('low:end')
      })
      createEffect(() => {
        if (high() === 1) order.push('high')
      })

      startTransition(() => low(1))
      await tick()
      await tick()

      expect(order).toEqual(['low:start', 'low:end', 'high'])
    })
  })

  describe('startTransition', () => {
    it('marks updates as low priority', async () => {
      const value = createSignal(0)
      let effectRuns = 0

      createEffect(() => {
        value()
        effectRuns++
      })

      effectRuns = 0 // Reset after initial run

      startTransition(() => {
        value(1)
        value(2)
        value(3)
      })

      await tick()
      await tick()

      // Effect should run once with final value
      expect(effectRuns).toBe(1)
      expect(value()).toBe(3)
    })

    it('can be nested with batch', async () => {
      const value = createSignal(0)
      let effectRuns = 0

      createEffect(() => {
        value()
        effectRuns++
      })

      effectRuns = 0

      startTransition(() => {
        batch(() => {
          value(1)
          value(2)
        })
      })

      await tick()

      expect(effectRuns).toBe(1)
      expect(value()).toBe(2)
    })
  })

  describe('useTransition', () => {
    it('returns pending state during transition', async () => {
      const [isPending, start] = useTransition()
      const pendingStatesInEffect: boolean[] = []

      const value = createSignal(0)

      createEffect(() => {
        value()
        // Capture pending state when effect runs
        pendingStatesInEffect.push(isPending())
      })

      // Initial state
      expect(isPending()).toBe(false)
      expect(pendingStatesInEffect).toEqual([false]) // Initial effect run

      // Capture pending state during transition callback
      let pendingDuringCallback = false
      start(() => {
        pendingDuringCallback = isPending()
        value(1)
      })

      // Pending should be true during the transition callback
      expect(pendingDuringCallback).toBe(true)

      await tick()
      await tick()

      // After transition completes, pending should be false
      expect(isPending()).toBe(false)
    })

    it('start function triggers low priority update', async () => {
      const [, start] = useTransition()
      const value = createSignal(0)
      let effectRuns = 0

      createEffect(() => {
        value()
        effectRuns++
      })

      effectRuns = 0

      start(() => {
        value(1)
      })

      await tick()
      await tick()

      expect(effectRuns).toBe(1)
      expect(value()).toBe(1)
    })

    it('keeps pending true until async transition work resolves', async () => {
      const [isPending, start] = useTransition()
      let resolveWork: (() => void) | undefined
      const work = new Promise<void>(resolve => {
        resolveWork = resolve
      })

      start(() => work)
      expect(isPending()).toBe(true)

      await tick()
      expect(isPending()).toBe(true)

      resolveWork!()
      await tick()
      await tick()
      expect(isPending()).toBe(false)
    })

    it('clears pending and reports async transition rejections', async () => {
      const [isPending, start] = useTransition()
      const error = new Error('transition failed')
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      start(() => Promise.reject(error))
      expect(isPending()).toBe(true)

      await tick()
      await tick()

      expect(isPending()).toBe(false)
      expect(errorSpy).toHaveBeenCalledWith('[fict/transition] Async transition failed.', error)
      errorSpy.mockRestore()
    })

    it('rethrows undefined errors from transition callbacks and clears pending', () => {
      const [isPending, start] = useTransition()
      let caught: unknown = null

      try {
        start(() => {
          throw undefined
        })
      } catch (err) {
        caught = err
      }

      expect(caught).toBe(undefined)
      expect(isPending()).toBe(false)
    })
  })

  describe('useDeferredValue', () => {
    it('creates a deferred version of a value', async () => {
      const source = createSignal(0)
      const deferred = useDeferredValue(() => source())

      // Initially both should be equal
      expect(deferred()).toBe(0)

      // Update source
      source(1)
      await tick()
      await tick()
      await tick()

      // Deferred should eventually catch up
      expect(deferred()).toBe(1)
    })

    it('deferred value lags behind source during rapid updates', async () => {
      const source = createSignal(0)
      const deferred = useDeferredValue(() => source())

      const deferredValues: number[] = []
      createEffect(() => {
        deferredValues.push(deferred())
      })

      // Rapid updates
      source(1)
      source(2)
      source(3)

      await tick()

      // Source should be at final value
      expect(source()).toBe(3)

      await tick()
      await tick()
      await tick()

      // Deferred should eventually match
      expect(deferred()).toBe(3)
    })
  })

  describe('Integration', () => {
    it('works with existing batch mechanism', async () => {
      const value = createSignal(0)
      const runs: number[] = []

      createEffect(() => {
        runs.push(value())
      })

      runs.length = 0

      batch(() => {
        startTransition(() => {
          value(1)
        })
        value(2) // This should be high priority but batched
      })

      await tick()
      await tick()

      // Both updates should have been processed
      expect(value()).toBe(2)
    })
  })
})
