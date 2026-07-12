import { describe, expect, it, vi } from 'vitest'

import { hook, subscribeToLiveTrace } from '../src/core/debugger'

describe('DevTools live trace observer', () => {
  it('publishes source-backed runtime updates without trusting observer callbacks', () => {
    const updates: unknown[] = []
    const listener = vi.fn((update: unknown) => updates.push(update))
    const stop = subscribeToLiveTrace(listener)
    const stopThrowingListener = subscribeToLiveTrace(() => {
      throw new Error('observer failed')
    })

    hook.registerSignal(910_001, 0, {
      name: 'count',
      source: '/tmp/Counter.tsx:4:15',
    })
    expect(() => hook.updateSignal(910_001, 1, 0)).not.toThrow()
    hook.registerEffect(910_002, { source: '/tmp/Counter.tsx:8:3' })
    hook.effectRun(910_002, 2.5)

    expect(updates).toEqual([
      {
        type: 'trace/update',
        file: '/tmp/Counter.tsx',
        line: 4,
        kind: 'once',
        runCount: 1,
        lastDurationMs: undefined,
      },
      {
        type: 'trace/update',
        file: '/tmp/Counter.tsx',
        line: 4,
        kind: 'reactive',
        runCount: 1,
        lastDurationMs: undefined,
      },
      {
        type: 'trace/update',
        file: '/tmp/Counter.tsx',
        line: 8,
        kind: 'effect',
        runCount: 1,
        lastDurationMs: 2.5,
      },
    ])

    stop()
    stopThrowingListener()
    hook.updateSignal(910_001, 2, 1)
    expect(listener).toHaveBeenCalledTimes(3)

    hook.disposeEffect(910_002)
    hook.disposeSignal(910_001)
  })
})
