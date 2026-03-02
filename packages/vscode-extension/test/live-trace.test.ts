import { describe, expect, it } from 'vitest'

import { LiveTraceStore, normalizeLiveTracePayload } from '../src/analysis/live-trace'

describe('live trace payload normalization', () => {
  it('normalizes valid trace update payloads', () => {
    const payload = normalizeLiveTracePayload({
      type: 'trace/update',
      file: '/tmp/counter.tsx',
      line: 12,
      kind: 'reactive',
      runCount: 4,
      lastDuration: 1.5,
    })

    expect(payload).toEqual({
      type: 'trace/update',
      file: '/tmp/counter.tsx',
      line: 12,
      kind: 'reactive',
      runCount: 4,
      lastDurationMs: 1.5,
    })
  })

  it('rejects non-trace payloads', () => {
    expect(normalizeLiveTracePayload({ type: 'noop' })).toBeNull()
    expect(normalizeLiveTracePayload(null)).toBeNull()
  })
})

describe('live trace store', () => {
  it('stores and updates line updates by file', () => {
    const store = new LiveTraceStore()
    const first = normalizeLiveTracePayload({
      type: 'trace/update',
      file: '/tmp/counter.tsx',
      line: 7,
      kind: 'effect',
      runCount: 1,
    })
    const second = normalizeLiveTracePayload({
      type: 'trace/update',
      file: '/tmp/counter.tsx',
      line: 7,
      runCount: 2,
      lastDurationMs: 3.2,
    })

    expect(first).not.toBeNull()
    expect(second).not.toBeNull()

    store.apply(first!)
    store.apply(second!)

    const updates = store.getLineUpdates('/tmp/counter.tsx')
    const line = updates.get(7)
    expect(line?.kind).toBe('effect')
    expect(line?.runCount).toBe(2)
    expect(line?.lastDurationMs).toBe(3.2)
  })
})
