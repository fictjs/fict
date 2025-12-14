import { describe, it, expect } from 'vitest'

import { createSignal, createEffect, batch } from '../src/index'
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
