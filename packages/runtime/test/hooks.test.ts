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
    it('creates a new context when stack is empty', () => {
      const ctx = __fictUseContext()
      expect(ctx).toBeDefined()
      expect(ctx.slots).toEqual([])
      expect(ctx.cursor).toBe(0)
      expect(ctx.rendering).toBe(true)
    })

    it('reuses existing context when called again', () => {
      const ctx1 = __fictUseContext()
      ctx1.cursor = 5
      ctx1.rendering = false

      const ctx2 = __fictUseContext()
      expect(ctx2).toBe(ctx1)
      expect(ctx2.cursor).toBe(0) // Reset
      expect(ctx2.rendering).toBe(true) // Reset
    })

    it('returns the top of the context stack', () => {
      const ctx1 = __fictUseContext()
      const ctx2 = __fictPushContext()

      // __fictUseContext should return ctx2 (top of stack)
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

      // After reset, __fictUseContext creates a fresh context
      const newCtx = __fictUseContext()
      expect(newCtx).toBeDefined()
      expect(newCtx.slots).toEqual([])
    })
  })

  describe('__fictUseSignal', () => {
    it('creates a signal on first call', () => {
      const ctx = __fictUseContext()
      const signal = __fictUseSignal(ctx, 42)

      expect(signal).toBeTypeOf('function')
      expect(signal()).toBe(42)
    })

    it('reuses signal on subsequent calls', () => {
      const ctx = __fictUseContext()
      const signal1 = __fictUseSignal(ctx, 42)
      signal1(100)

      ctx.cursor = 0 // Reset cursor to simulate re-render
      ctx.rendering = true

      const signal2 = __fictUseSignal(ctx, 42)
      expect(signal2).toBe(signal1)
      expect(signal2()).toBe(100) // Value preserved
    })

    it('uses explicit slot index when provided', () => {
      const ctx = __fictUseContext()
      const signal1 = __fictUseSignal(ctx, 'a', 5)
      const signal2 = __fictUseSignal(ctx, 'b', 3)

      expect(ctx.slots[5]).toBe(signal1)
      expect(ctx.slots[3]).toBe(signal2)
    })

    it('increments cursor when no slot is provided', () => {
      const ctx = __fictUseContext()
      expect(ctx.cursor).toBe(0)

      __fictUseSignal(ctx, 'a')
      expect(ctx.cursor).toBe(1)

      __fictUseSignal(ctx, 'b')
      expect(ctx.cursor).toBe(2)
    })

    it('throws when called outside render context', () => {
      const ctx = __fictUseContext()
      ctx.rendering = false

      expect(() => __fictUseSignal(ctx, 42)).toThrow()
    })
  })

  describe('__fictUseMemo', () => {
    it('creates a memo on first call', () => {
      const ctx = __fictUseContext()
      const memo = __fictUseMemo(ctx, () => 42)

      expect(memo).toBeTypeOf('function')
      expect(memo()).toBe(42)
    })

    it('reuses memo on subsequent calls', () => {
      const ctx = __fictUseContext()
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
      const ctx = __fictUseContext()
      const memo = __fictUseMemo(ctx, () => 'computed', 7)

      expect(ctx.slots[7]).toBe(memo)
    })

    it('throws when called outside render context', () => {
      const ctx = __fictUseContext()
      ctx.rendering = false

      expect(() => __fictUseMemo(ctx, () => 42)).toThrow()
    })
  })

  describe('__fictUseEffect', () => {
    it('creates an effect on first call', async () => {
      const ctx = __fictUseContext()
      let effectRan = false

      __fictUseEffect(ctx, () => {
        effectRan = true
      })

      await tick()
      expect(effectRan).toBe(true)
    })

    it('does not recreate effect on subsequent calls', async () => {
      const ctx = __fictUseContext()
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
      const ctx = __fictUseContext()
      __fictUseEffect(ctx, () => {}, 4)

      expect(ctx.slots[4]).toBeDefined()
    })

    it('throws when called outside render context', () => {
      const ctx = __fictUseContext()
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
})
