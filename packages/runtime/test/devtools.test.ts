import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import { createEffect } from '../src/index'
import { createSignal } from '../src/advanced'

describe('devtools hook integration', () => {
  let original: unknown
  let events: string[]

  beforeEach(() => {
    original = (globalThis as any).__FICT_DEVTOOLS_HOOK__
    events = []
    ;(globalThis as any).__FICT_DEVTOOLS_HOOK__ = {
      registerSignal: (id: number, value: unknown) => {
        events.push(`signal:${id}:register:${String(value)}`)
      },
      updateSignal: (id: number, value: unknown) => {
        events.push(`signal:${id}:update:${String(value)}`)
      },
      registerEffect: (id: number) => {
        events.push(`effect:${id}:register`)
      },
      effectRun: (id: number) => {
        events.push(`effect:${id}:run`)
      },
    }
  })

  afterEach(() => {
    ;(globalThis as any).__FICT_DEVTOOLS_HOOK__ = original
  })

  it('emits devtools events for signal and effect', () => {
    const count = createSignal(0)
    createEffect(() => {
      count()
    })

    expect(events.some(e => e.includes('signal:1:register'))).toBe(true)
    expect(events.some(e => e.includes('effect:1:register'))).toBe(true)
    expect(events.filter(e => e.endsWith(':run')).length).toBeGreaterThan(0)

    count(1)
    expect(events.some(e => e.includes('signal:1:update:1'))).toBe(true)
  })
})
