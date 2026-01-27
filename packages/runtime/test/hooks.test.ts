import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import {
  __fictUseContext,
  __fictPushContext,
  __fictPopContext,
  __fictResetContext,
  __fictUseSignal,
  __fictUseMemo,
  __fictUseEffect,
  __fictRender,
} from '../src/internal'

const tick = () =>
  new Promise<void>(resolve =>
    typeof queueMicrotask === 'function'
      ? queueMicrotask(resolve)
      : Promise.resolve().then(resolve),
  )

describe('Hook Context System', () => {
  beforeEach(() => {
    __fictResetContext()
  })

  afterEach(() => {
    __fictResetContext()
  })

  describe('__fictUseContext', () => {
    it('throws when stack is empty (fix)', () => {
      // Hooks should not be called outside render context
      expect(() => __fictUseContext()).toThrow(/Invalid hook call/)
    })

    it('returns existing context and resets cursor when not rendering', () => {
      const ctx1 = __fictPushContext()
      ctx1.cursor = 5
      ctx1.rendering = false

      const ctx2 = __fictUseContext()
      expect(ctx2).toBe(ctx1)
      expect(ctx2.cursor).toBe(0) // Reset because rendering was false
      expect(ctx2.rendering).toBe(true) // Now rendering
    })

    it('returns existing context without resetting cursor when already rendering (fix)', () => {
      // Custom hooks should not reset cursor
      const ctx1 = __fictPushContext()
      ctx1.cursor = 5
      ctx1.rendering = true

      const ctx2 = __fictUseContext()
      expect(ctx2).toBe(ctx1)
      expect(ctx2.cursor).toBe(5) // NOT reset because already rendering
      expect(ctx2.rendering).toBe(true)
    })

    it('returns the top of the context stack', () => {
      const ctx1 = __fictPushContext()
      const ctx2 = __fictPushContext()

      // __fictUseContext should return ctx2 (top of stack)
      ctx2.rendering = false // Reset so __fictUseContext will set it
      const ctx3 = __fictUseContext()
      expect(ctx3).toBe(ctx2)
    })
  })

  describe('__fictPushContext / __fictPopContext', () => {
    it('pushes a new context onto the stack', () => {
      const ctx1 = __fictPushContext()
      expect(ctx1).toBeDefined()
      expect(ctx1.slots).toEqual([])
      expect(ctx1.cursor).toBe(0)
    })

    it('creates isolated contexts on push', () => {
      const ctx1 = __fictPushContext()
      ctx1.slots.push('value1')

      const ctx2 = __fictPushContext()
      expect(ctx2.slots).toEqual([])
      expect(ctx2).not.toBe(ctx1)
    })

    it('pops context from the stack', () => {
      const ctx1 = __fictPushContext()
      const ctx2 = __fictPushContext()

      __fictPopContext()
      const ctx3 = __fictUseContext()

      expect(ctx3).toBe(ctx1)
    })

    it('handles multiple push/pop operations', () => {
      const ctx1 = __fictPushContext()
      const ctx2 = __fictPushContext()
      const ctx3 = __fictPushContext()

      __fictPopContext() // Remove ctx3
      const current1 = __fictUseContext()
      expect(current1).toBe(ctx2)

      __fictPopContext() // Remove ctx2
      const current2 = __fictUseContext()
      expect(current2).toBe(ctx1)
    })
  })

  describe('__fictResetContext', () => {
    it('clears the entire context stack', () => {
      __fictPushContext()
      __fictPushContext()
      __fictPushContext()

      __fictResetContext()

      // After reset, __fictUseContext throws because stack is empty ()
      expect(() => __fictUseContext()).toThrow(/Invalid hook call/)

      // Can push a new context after reset
      const newCtx = __fictPushContext()
      expect(newCtx).toBeDefined()
      expect(newCtx.slots).toEqual([])
    })
  })

  describe('__fictUseSignal', () => {
    it('creates a signal on first call', () => {
      const ctx = __fictPushContext()
      ctx.rendering = true
      const signal = __fictUseSignal(ctx, 42)

      expect(signal).toBeTypeOf('function')
      expect(signal()).toBe(42)
    })

    it('reuses signal on subsequent calls', () => {
      const ctx = __fictPushContext()
      ctx.rendering = true
      const signal1 = __fictUseSignal(ctx, 42)
      signal1(100)

      ctx.cursor = 0 // Reset cursor to simulate re-render
      ctx.rendering = true

      const signal2 = __fictUseSignal(ctx, 42)
      expect(signal2).toBe(signal1)
      expect(signal2()).toBe(100) // Value preserved
    })

    it('uses explicit slot index when provided', () => {
      const ctx = __fictPushContext()
      ctx.rendering = true
      const signal1 = __fictUseSignal(ctx, 'a', 5)
      const signal2 = __fictUseSignal(ctx, 'b', 3)

      expect(ctx.slots[5]).toBe(signal1)
      expect(ctx.slots[3]).toBe(signal2)
    })

    it('increments cursor when no slot is provided', () => {
      const ctx = __fictPushContext()
      ctx.rendering = true
      expect(ctx.cursor).toBe(0)

      __fictUseSignal(ctx, 'a')
      expect(ctx.cursor).toBe(1)

      __fictUseSignal(ctx, 'b')
      expect(ctx.cursor).toBe(2)
    })

    it('throws when called outside render context', () => {
      const ctx = __fictPushContext()
      ctx.rendering = false

      expect(() => __fictUseSignal(ctx, 42)).toThrow()
    })
  })

  describe('__fictUseMemo', () => {
    it('creates a memo on first call', () => {
      const ctx = __fictPushContext()
      ctx.rendering = true
      const memo = __fictUseMemo(ctx, () => 42)

      expect(memo).toBeTypeOf('function')
      expect(memo()).toBe(42)
    })

    it('reuses memo on subsequent calls', () => {
      const ctx = __fictPushContext()
      ctx.rendering = true
      let computeCount = 0
      const memo1 = __fictUseMemo(ctx, () => {
        computeCount++
        return 42
      })
      // Memos are lazily evaluated, so we need to call it to trigger computation
      expect(memo1()).toBe(42)
      expect(computeCount).toBe(1)

      ctx.cursor = 0
      ctx.rendering = true

      const memo2 = __fictUseMemo(ctx, () => {
        computeCount++
        return 99
      })
      expect(memo2).toBe(memo1)
      expect(memo2()).toBe(42) // Same value because same memo instance
      expect(computeCount).toBe(1) // Not recomputed because same memo instance
    })

    it('uses explicit slot index when provided', () => {
      const ctx = __fictPushContext()
      ctx.rendering = true
      const memo = __fictUseMemo(ctx, () => 'computed', 7)

      expect(ctx.slots[7]).toBe(memo)
    })

    it('throws when called outside render context', () => {
      const ctx = __fictPushContext()
      ctx.rendering = false

      expect(() => __fictUseMemo(ctx, () => 42)).toThrow()
    })
  })

  describe('__fictUseEffect', () => {
    it('creates an effect on first call', async () => {
      const ctx = __fictPushContext()
      ctx.rendering = true
      let effectRan = false

      __fictUseEffect(ctx, () => {
        effectRan = true
      })

      await tick()
      expect(effectRan).toBe(true)
    })

    it('does not recreate effect on subsequent calls', async () => {
      const ctx = __fictPushContext()
      ctx.rendering = true
      let effectCount = 0

      __fictUseEffect(ctx, () => {
        effectCount++
      })

      await tick()
      expect(effectCount).toBe(1)

      ctx.cursor = 0
      ctx.rendering = true

      __fictUseEffect(ctx, () => {
        effectCount++
      })

      await tick()
      expect(effectCount).toBe(1) // Not recreated
    })

    it('uses explicit slot index when provided', () => {
      const ctx = __fictPushContext()
      ctx.rendering = true
      __fictUseEffect(ctx, () => {}, 4)

      expect(ctx.slots[4]).toBeDefined()
    })

    it('throws when called outside render context', () => {
      const ctx = __fictPushContext()
      ctx.rendering = false

      expect(() => __fictUseEffect(ctx, () => {})).toThrow()
    })
  })

  describe('__fictRender', () => {
    it('executes function with context pushed onto stack', () => {
      const ctx = { slots: [], cursor: 0, rendering: false }
      let insideRendering: boolean | undefined

      const result = __fictRender(ctx, () => {
        insideRendering = ctx.rendering
        return 'result'
      })

      expect(result).toBe('result')
      expect(insideRendering).toBe(true)
      expect(ctx.rendering).toBe(false) // Reset after render
    })

    it('resets cursor to 0 before rendering', () => {
      const ctx = { slots: [], cursor: 10, rendering: false }

      __fictRender(ctx, () => {
        expect(ctx.cursor).toBe(0)
        return null
      })
    })

    it('pops context even if function throws', () => {
      const ctx = { slots: [], cursor: 0, rendering: false }

      expect(() => {
        __fictRender(ctx, () => {
          throw new Error('test error')
        })
      }).toThrow('test error')

      expect(ctx.rendering).toBe(false)
    })

    it('supports nested render calls', () => {
      const ctx1 = { slots: ['a'], cursor: 0, rendering: false }
      const ctx2 = { slots: ['b'], cursor: 0, rendering: false }

      let innerResult: unknown
      const outerResult = __fictRender(ctx1, () => {
        innerResult = __fictRender(ctx2, () => {
          return ctx2.slots[0]
        })
        return ctx1.slots[0]
      })

      expect(outerResult).toBe('a')
      expect(innerResult).toBe('b')
    })
  })

  describe('Integration: Hook Context with Signals and Memos', () => {
    it('preserves state across re-renders', async () => {
      const ctx = __fictPushContext()
      let renderCount = 0

      const render = () => {
        return __fictRender(ctx, () => {
          renderCount++
          const count = __fictUseSignal(ctx, 0)
          const doubled = __fictUseMemo(ctx, () => count() * 2)
          return { count, doubled }
        })
      }

      // First render
      const { count, doubled } = render()
      expect(count()).toBe(0)
      expect(doubled()).toBe(0)

      // Update signal
      count(5)
      await tick()
      expect(doubled()).toBe(10)

      // Second render - should reuse the same signal and memo
      const result2 = render()
      expect(result2.count).toBe(count)
      expect(result2.doubled).toBe(doubled)
      expect(result2.count()).toBe(5)
      expect(result2.doubled()).toBe(10)

      __fictPopContext()
    })

    it('isolates state between different contexts', () => {
      const ctx1 = __fictPushContext()
      const ctx2 = __fictPushContext()

      const signal1 = __fictRender(ctx1, () => __fictUseSignal(ctx1, 'context1'))
      const signal2 = __fictRender(ctx2, () => __fictUseSignal(ctx2, 'context2'))

      expect(signal1()).toBe('context1')
      expect(signal2()).toBe('context2')
      expect(signal1).not.toBe(signal2)

      __fictPopContext()
      __fictPopContext()
    })
  })

  describe('Custom hook slot correctness', () => {
    it('custom hooks share hook slot sequence with calling component', () => {
      // Simulates the pattern: Component calls $state, then calls useCounter()
      // which also uses $state internally. Slots should not conflict.
      const ctx = __fictPushContext()

      // Simulate component render that calls a custom hook
      __fictRender(ctx, () => {
        // Component's own state (cursor starts at 0, so slot 0)
        const componentState = __fictUseSignal(ctx, 'component')
        expect(ctx.cursor).toBe(1) // cursor advanced to 1

        // Custom hook is called - should continue from cursor 1, not reset to 0
        // This simulates what happens when a custom hook calls __fictUseContext()
        const customHookCtx = __fictUseContext() // Should NOT reset cursor!
        expect(customHookCtx).toBe(ctx) // Same context
        expect(customHookCtx.cursor).toBe(1) // Cursor preserved (fix)

        // Custom hook creates its own state (slot 1, cursor advances to 2)
        const hookState = __fictUseSignal(ctx, 'hook')
        expect(ctx.cursor).toBe(2)

        // Verify states are in correct slots
        expect(ctx.slots[0]).toBe(componentState)
        expect(ctx.slots[1]).toBe(hookState)

        // States should be independent
        expect(componentState()).toBe('component')
        expect(hookState()).toBe('hook')

        return null
      })

      __fictPopContext()
    })

    it('multiple custom hooks maintain correct slot sequence', () => {
      const ctx = __fictPushContext()

      __fictRender(ctx, () => {
        // Component state - slot 0, cursor -> 1
        const s1 = __fictUseSignal(ctx, 1)

        // First custom hook (simulated)
        __fictUseContext() // Should not reset cursor (fix)
        const s2 = __fictUseSignal(ctx, 2) // slot 1, cursor -> 2
        const m1 = __fictUseMemo(ctx, () => s1() + s2()) // slot 2, cursor -> 3

        // Second custom hook (simulated)
        __fictUseContext() // Should not reset cursor (fix)
        const s3 = __fictUseSignal(ctx, 3) // slot 3, cursor -> 4

        // Total: 4 slots used (s1, s2, m1, s3)
        expect(ctx.cursor).toBe(4)
        expect(s1()).toBe(1)
        expect(s2()).toBe(2)
        expect(s3()).toBe(3)
        expect(m1()).toBe(3)

        return null
      })

      __fictPopContext()
    })
  })
})
