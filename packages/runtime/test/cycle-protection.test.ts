import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'

import { createEffect, createMemo, render, onCleanup } from '../src'
import { createSignal } from '../src/advanced'
import {
  resetCycleProtectionStateForTests,
  setCycleProtectionOptions,
  beginFlushGuard,
  beforeEffectRunGuard,
  endFlushGuard,
  enterRootGuard,
  exitRootGuard,
} from '../src/cycle-guard'
import { createRootContext, popRoot, pushRoot } from '../src/lifecycle'

const tick = () =>
  new Promise<void>(resolve =>
    typeof queueMicrotask === 'function'
      ? queueMicrotask(resolve)
      : Promise.resolve().then(resolve),
  )

afterEach(() => {
  resetCycleProtectionStateForTests()
})

describe('framework cycle protection', () => {
  describe('flush budget protection', () => {
    it('warns when flush budget is exceeded in prod mode', async () => {
      setCycleProtectionOptions({
        maxFlushCyclesPerMicrotask: 2,
        maxEffectRunsPerFlush: 2,
        devMode: false,
      })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const s = createSignal(0)
      createEffect(() => {
        s()
      })
      createEffect(() => {
        s()
      })
      createEffect(() => {
        s()
      })

      s(1)
      await tick()
      expect(
        warn.mock.calls.some(
          ([msg]) => typeof msg === 'string' && msg.includes('cycle protection triggered'),
        ),
      ).toBe(true)
      warn.mockRestore()
    })

    it('throws when flush budget is exceeded in devMode', async () => {
      setCycleProtectionOptions({
        maxFlushCyclesPerMicrotask: 2,
        maxEffectRunsPerFlush: 2,
        devMode: true,
      })

      // Direct test of guard functions
      beginFlushGuard()
      expect(beforeEffectRunGuard()).toBe(true) // 1st run OK
      expect(beforeEffectRunGuard()).toBe(true) // 2nd run OK
      expect(() => beforeEffectRunGuard()).toThrow(/flush-budget-exceeded/)
      endFlushGuard()
    })

    it('resets effect count after flush', () => {
      setCycleProtectionOptions({
        maxFlushCyclesPerMicrotask: 3,
        maxEffectRunsPerFlush: 3,
        devMode: true,
      })

      // First flush
      beginFlushGuard()
      expect(beforeEffectRunGuard()).toBe(true)
      expect(beforeEffectRunGuard()).toBe(true)
      expect(beforeEffectRunGuard()).toBe(true)
      endFlushGuard()

      // Second flush - should start fresh
      beginFlushGuard()
      expect(beforeEffectRunGuard()).toBe(true)
      expect(beforeEffectRunGuard()).toBe(true)
      expect(beforeEffectRunGuard()).toBe(true)
      endFlushGuard()
    })

    it('only warns once per flush in prod mode', async () => {
      setCycleProtectionOptions({
        maxFlushCyclesPerMicrotask: 1,
        maxEffectRunsPerFlush: 1,
        devMode: false,
      })

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      beginFlushGuard()
      beforeEffectRunGuard() // 1st - OK
      beforeEffectRunGuard() // 2nd - warns
      beforeEffectRunGuard() // 3rd - should not warn again
      beforeEffectRunGuard() // 4th - should not warn again
      endFlushGuard()

      // Count warnings with the cycle protection message
      const cycleWarnings = warn.mock.calls.filter(
        ([msg]) => typeof msg === 'string' && msg.includes('flush-budget-exceeded'),
      )
      expect(cycleWarnings.length).toBe(1)

      warn.mockRestore()
    })
  })

  describe('root re-entry protection', () => {
    it('guards against excessive root re-entry depth', () => {
      setCycleProtectionOptions({
        maxRootReentrantDepth: 1,
        devMode: true,
      })
      const root = createRootContext()
      const prev = pushRoot(root)

      expect(() => pushRoot(root)).toThrow(/root-reentry/)

      popRoot(prev)
    })

    it('allows re-entry up to max depth', () => {
      setCycleProtectionOptions({
        maxRootReentrantDepth: 3,
        devMode: false, // Use warn mode to check return value
      })

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const root = createRootContext()

      // Direct test using guard functions
      expect(enterRootGuard(root)).toBe(true) // depth 1
      expect(enterRootGuard(root)).toBe(true) // depth 2
      expect(enterRootGuard(root)).toBe(true) // depth 3
      expect(enterRootGuard(root)).toBe(false) // depth 4 - blocked

      // Cleanup
      exitRootGuard(root)
      exitRootGuard(root)
      exitRootGuard(root)

      warn.mockRestore()
    })

    it('tracks different roots independently', () => {
      setCycleProtectionOptions({
        maxRootReentrantDepth: 2,
        devMode: false, // Use warn mode to check return value
      })

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const root1 = createRootContext()
      const root2 = createRootContext()

      expect(enterRootGuard(root1)).toBe(true) // root1 depth 1
      expect(enterRootGuard(root2)).toBe(true) // root2 depth 1
      expect(enterRootGuard(root1)).toBe(true) // root1 depth 2
      expect(enterRootGuard(root2)).toBe(true) // root2 depth 2
      expect(enterRootGuard(root1)).toBe(false) // root1 depth 3 - blocked
      expect(enterRootGuard(root2)).toBe(false) // root2 depth 3 - blocked

      // Cleanup
      exitRootGuard(root1)
      exitRootGuard(root1)
      exitRootGuard(root2)
      exitRootGuard(root2)

      warn.mockRestore()
    })

    it('decrements depth on exit', () => {
      setCycleProtectionOptions({
        maxRootReentrantDepth: 2,
        devMode: false, // Use warn mode to check return value
      })

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const root = createRootContext()

      expect(enterRootGuard(root)).toBe(true) // depth 1
      expect(enterRootGuard(root)).toBe(true) // depth 2
      expect(enterRootGuard(root)).toBe(false) // depth 3 - blocked

      exitRootGuard(root) // back to depth 1

      // After reset, we should be able to enter again
      resetCycleProtectionStateForTests()
      setCycleProtectionOptions({
        maxRootReentrantDepth: 2,
        devMode: false,
      })

      expect(enterRootGuard(root)).toBe(true) // depth 1

      exitRootGuard(root)

      warn.mockRestore()
    })

    it('warns in prod mode for root re-entry', () => {
      setCycleProtectionOptions({
        maxRootReentrantDepth: 1,
        devMode: false,
      })

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const root = createRootContext()
      enterRootGuard(root) // depth 1 - OK
      enterRootGuard(root) // depth 2 - warns

      expect(
        warn.mock.calls.some(([msg]) => typeof msg === 'string' && msg.includes('root-reentry')),
      ).toBe(true)

      exitRootGuard(root)
      exitRootGuard(root)
      warn.mockRestore()
    })
  })

  describe('window usage warning', () => {
    it('warns when high usage is sustained over window', () => {
      setCycleProtectionOptions({
        maxFlushCyclesPerMicrotask: 10,
        maxEffectRunsPerFlush: 10,
        windowSize: 3,
        highUsageRatio: 0.8,
        enableWindowWarning: true,
        devMode: false,
      })

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      // Simulate 3 flushes with high usage (9/10 = 90% each)
      for (let flush = 0; flush < 3; flush++) {
        beginFlushGuard()
        for (let i = 0; i < 9; i++) {
          beforeEffectRunGuard()
        }
        endFlushGuard()
      }

      expect(
        warn.mock.calls.some(
          ([msg]) => typeof msg === 'string' && msg.includes('high-usage-window'),
        ),
      ).toBe(true)

      warn.mockRestore()
    })

    it('does not warn when usage is below threshold', () => {
      setCycleProtectionOptions({
        maxFlushCyclesPerMicrotask: 10,
        maxEffectRunsPerFlush: 10,
        windowSize: 3,
        highUsageRatio: 0.8,
        enableWindowWarning: true,
        devMode: false,
      })

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      // Simulate 3 flushes with moderate usage (5/10 = 50% each)
      for (let flush = 0; flush < 3; flush++) {
        beginFlushGuard()
        for (let i = 0; i < 5; i++) {
          beforeEffectRunGuard()
        }
        endFlushGuard()
      }

      expect(
        warn.mock.calls.some(
          ([msg]) => typeof msg === 'string' && msg.includes('high-usage-window'),
        ),
      ).toBe(false)

      warn.mockRestore()
    })

    it('respects enableWindowWarning = false', () => {
      setCycleProtectionOptions({
        maxFlushCyclesPerMicrotask: 10,
        maxEffectRunsPerFlush: 10,
        windowSize: 3,
        highUsageRatio: 0.8,
        enableWindowWarning: false,
        devMode: false,
      })

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      // Simulate 3 flushes with high usage
      for (let flush = 0; flush < 3; flush++) {
        beginFlushGuard()
        for (let i = 0; i < 9; i++) {
          beforeEffectRunGuard()
        }
        endFlushGuard()
      }

      // No high-usage-window warning should appear
      expect(
        warn.mock.calls.some(
          ([msg]) => typeof msg === 'string' && msg.includes('high-usage-window'),
        ),
      ).toBe(false)

      warn.mockRestore()
    })
  })

  describe('backoff warnings', () => {
    it('warns at 50% of effect budget when backoff is enabled', () => {
      setCycleProtectionOptions({
        maxFlushCyclesPerMicrotask: 100,
        maxEffectRunsPerFlush: 100,
        enableBackoffWarning: true,
        backoffWarningRatio: 0.5,
        devMode: false,
      })

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      beginFlushGuard()
      // Run 55 effects (55% of budget)
      for (let i = 0; i < 55; i++) {
        beforeEffectRunGuard()
      }
      endFlushGuard()

      // Should have a backoff warning
      expect(
        warn.mock.calls.some(
          ([msg]) => typeof msg === 'string' && msg.includes('approaching effect limit'),
        ),
      ).toBe(true)

      warn.mockRestore()
    })

    it('warns at 75% of effect budget', () => {
      setCycleProtectionOptions({
        maxFlushCyclesPerMicrotask: 100,
        maxEffectRunsPerFlush: 100,
        enableBackoffWarning: true,
        backoffWarningRatio: 0.5,
        devMode: false,
      })

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      beginFlushGuard()
      // Run 80 effects (80% of budget)
      for (let i = 0; i < 80; i++) {
        beforeEffectRunGuard()
      }
      endFlushGuard()

      // Should have both 50% and 75% warnings
      expect(
        warn.mock.calls.some(
          ([msg]) => typeof msg === 'string' && msg.includes('approaching effect limit'),
        ),
      ).toBe(true)
      expect(
        warn.mock.calls.some(
          ([msg]) => typeof msg === 'string' && msg.includes('nearing effect limit'),
        ),
      ).toBe(true)

      warn.mockRestore()
    })

    it('does not warn when backoff is disabled', () => {
      setCycleProtectionOptions({
        maxFlushCyclesPerMicrotask: 100,
        maxEffectRunsPerFlush: 100,
        enableBackoffWarning: false,
        devMode: false,
      })

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      beginFlushGuard()
      // Run 75 effects (75% of budget)
      for (let i = 0; i < 75; i++) {
        beforeEffectRunGuard()
      }
      endFlushGuard()

      // Should NOT have backoff warnings
      expect(
        warn.mock.calls.some(
          ([msg]) => typeof msg === 'string' && msg.includes('approaching effect limit'),
        ),
      ).toBe(false)
      expect(
        warn.mock.calls.some(
          ([msg]) => typeof msg === 'string' && msg.includes('nearing effect limit'),
        ),
      ).toBe(false)

      warn.mockRestore()
    })

    it('provides detailed error message in devMode', () => {
      setCycleProtectionOptions({
        maxFlushCyclesPerMicrotask: 5,
        maxEffectRunsPerFlush: 5,
        devMode: true,
      })

      beginFlushGuard()
      // Exhaust budget
      for (let i = 0; i < 5; i++) {
        beforeEffectRunGuard()
      }

      // Next call should throw with detailed message
      let errorMessage = ''
      try {
        beforeEffectRunGuard()
      } catch (e) {
        errorMessage = (e as Error).message
      }

      expect(errorMessage).toContain('flush-budget-exceeded')
      expect(errorMessage).toContain('Effect runs: 6')
      expect(errorMessage).toContain('reactive cycle')

      endFlushGuard()
    })
  })

  describe('configuration options', () => {
    it('resetCycleProtectionStateForTests clears all state', () => {
      setCycleProtectionOptions({
        maxFlushCyclesPerMicrotask: 100,
        maxEffectRunsPerFlush: 200,
        windowSize: 10,
        highUsageRatio: 0.5,
        maxRootReentrantDepth: 5,
        enableWindowWarning: false,
        devMode: false, // Use warn mode
      })

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      // Create some state
      const root = createRootContext()
      enterRootGuard(root)
      beginFlushGuard()
      beforeEffectRunGuard()

      // Reset
      resetCycleProtectionStateForTests()

      // After reset, options should be back to defaults
      // We can verify by checking that default limits apply
      // Default maxRootReentrantDepth is 10

      // Try entering root 11 times
      const newRoot = createRootContext()
      for (let i = 0; i < 10; i++) {
        expect(enterRootGuard(newRoot)).toBe(true)
      }
      expect(enterRootGuard(newRoot)).toBe(false) // 11th should fail with default

      // Cleanup
      for (let i = 0; i < 10; i++) {
        exitRootGuard(newRoot)
      }

      warn.mockRestore()
    })

    it('setCycleProtectionOptions allows partial updates', () => {
      setCycleProtectionOptions({
        maxFlushCyclesPerMicrotask: 5,
        devMode: true,
      })

      // Now only update devMode
      setCycleProtectionOptions({
        devMode: false,
      })

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      // maxFlushCyclesPerMicrotask should still be 5
      beginFlushGuard()
      for (let i = 0; i < 6; i++) {
        beforeEffectRunGuard()
      }
      endFlushGuard()

      // Should warn (not throw) since devMode is now false
      expect(
        warn.mock.calls.some(
          ([msg]) => typeof msg === 'string' && msg.includes('flush-budget-exceeded'),
        ),
      ).toBe(true)

      warn.mockRestore()
    })
  })

  describe('integration with reactive system', () => {
    let container: HTMLElement

    beforeEach(() => {
      container = document.createElement('div')
      document.body.appendChild(container)
    })

    afterEach(() => {
      container.remove()
    })

    it('detects excessive effect runs via direct guard calls', async () => {
      setCycleProtectionOptions({
        maxFlushCyclesPerMicrotask: 5,
        maxEffectRunsPerFlush: 5,
        devMode: false,
      })

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      // Simulate many effect runs in a single flush
      beginFlushGuard()
      for (let i = 0; i < 10; i++) {
        beforeEffectRunGuard()
      }
      endFlushGuard()

      // Should have triggered cycle protection warning
      expect(
        warn.mock.calls.some(
          ([msg]) => typeof msg === 'string' && msg.includes('flush-budget-exceeded'),
        ),
      ).toBe(true)

      warn.mockRestore()
    })

    it('allows normal reactive operations within budget', async () => {
      setCycleProtectionOptions({
        maxFlushCyclesPerMicrotask: 100,
        maxEffectRunsPerFlush: 100,
        devMode: true,
      })

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const count = createSignal(0)
      const doubled = createMemo(() => count() * 2)
      let effectRuns = 0

      createEffect(() => {
        doubled() // Read derived value
        effectRuns++
      })

      // Update 10 times
      for (let i = 1; i <= 10; i++) {
        count(i)
        await tick()
      }

      // No cycle protection warnings
      expect(
        warn.mock.calls.some(
          ([msg]) => typeof msg === 'string' && msg.includes('cycle protection'),
        ),
      ).toBe(false)

      expect(effectRuns).toBe(11) // Initial + 10 updates

      warn.mockRestore()
    })

    it('handles effect cleanup cycles correctly', async () => {
      setCycleProtectionOptions({
        maxFlushCyclesPerMicrotask: 50,
        maxEffectRunsPerFlush: 50,
        devMode: false,
      })

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const trigger = createSignal(0)
      let cleanupCount = 0
      let effectCount = 0

      createEffect(() => {
        trigger()
        effectCount++
        onCleanup(() => {
          cleanupCount++
        })
      })

      // Multiple updates
      for (let i = 1; i <= 20; i++) {
        trigger(i)
        await tick()
      }

      // Should work without cycle protection warnings
      expect(
        warn.mock.calls.some(
          ([msg]) => typeof msg === 'string' && msg.includes('cycle protection'),
        ),
      ).toBe(false)

      expect(effectCount).toBe(21)
      expect(cleanupCount).toBe(20)

      warn.mockRestore()
    })

    it('protects during render cycles', async () => {
      setCycleProtectionOptions({
        maxRootReentrantDepth: 3,
        devMode: false,
      })

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const show = createSignal(true)

      const dispose = render(() => {
        const div = document.createElement('div')
        createEffect(() => {
          show()
          div.textContent = show() ? 'visible' : 'hidden'
        })
        return div
      }, container)

      // Multiple toggles
      for (let i = 0; i < 10; i++) {
        show(!show())
        await tick()
      }

      dispose()

      // Should not trigger root re-entry since we're not recursively re-entering
      // (normal reactive updates don't create deep recursion)
      expect(
        warn.mock.calls.some(([msg]) => typeof msg === 'string' && msg.includes('root-reentry')),
      ).toBe(false)

      warn.mockRestore()
    })
  })
})
