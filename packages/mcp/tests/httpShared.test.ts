import { describe, expect, it } from 'vitest'

import { evictSessionsToCapacity, pruneExpiredSessions } from '../src/server/transports/httpShared'

describe('httpShared session lifecycle utilities', () => {
  it('prunes expired sessions based on ttl', async () => {
    const sessions = new Map<string, { lastSeenAt: number }>([
      ['fresh', { lastSeenAt: 1000 }],
      ['expired-a', { lastSeenAt: 1 }],
      ['expired-b', { lastSeenAt: 100 }],
    ])
    const removed: string[] = []

    await pruneExpiredSessions({
      sessions,
      sessionTtlMs: 500,
      now: 1000,
      removeSessionById: async sessionId => {
        removed.push(sessionId)
        sessions.delete(sessionId)
      },
    })

    expect(removed).toEqual(['expired-a', 'expired-b'])
    expect([...sessions.keys()]).toEqual(['fresh'])
  })

  it('evicts oldest sessions until under max capacity', async () => {
    const sessions = new Map<string, { lastSeenAt: number }>([
      ['oldest', { lastSeenAt: 1 }],
      ['middle', { lastSeenAt: 2 }],
      ['newest', { lastSeenAt: 3 }],
    ])
    const removed: string[] = []

    await evictSessionsToCapacity({
      sessions,
      maxSessions: 2,
      removeSessionById: async sessionId => {
        removed.push(sessionId)
        sessions.delete(sessionId)
      },
    })

    expect(removed).toEqual(['oldest', 'middle'])
    expect([...sessions.keys()]).toEqual(['newest'])
  })
})
