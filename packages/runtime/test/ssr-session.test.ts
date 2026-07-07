import { describe, expect, it } from 'vitest'

import {
  __fictCreateSSRSession,
  __fictGetCurrentSSRSession,
  __fictRunWithSSRSession,
} from '../src/internal'

describe('SSR session stack', () => {
  it('keeps the sync helper scoped to the synchronous callback only', async () => {
    const session = __fictCreateSSRSession()
    let sessionDuringSyncCall: unknown
    let sessionAfterAwait: unknown

    const promise = __fictRunWithSSRSession(session, async () => {
      sessionDuringSyncCall = __fictGetCurrentSSRSession()
      await Promise.resolve()
      sessionAfterAwait = __fictGetCurrentSSRSession()
    })

    expect(__fictGetCurrentSSRSession()).toBeNull()

    await promise

    expect(sessionDuringSyncCall).toBe(session)
    expect(sessionAfterAwait).toBeNull()
    expect(__fictGetCurrentSSRSession()).toBeNull()
  })
})
