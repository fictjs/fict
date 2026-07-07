import { describe, expect, it } from 'vitest'

import {
  __fictCreateSSRSession,
  __fictGetCurrentSSRSession,
  __fictRunWithSSRSession,
  __fictRunWithSSRSessionAsync,
} from '../src/internal'

describe('SSR session stack', () => {
  it('keeps the current session across awaited async work', async () => {
    const session = __fictCreateSSRSession()

    const result = await __fictRunWithSSRSessionAsync(session, async () => {
      expect(__fictGetCurrentSSRSession()).toBe(session)

      await Promise.resolve()

      expect(__fictGetCurrentSSRSession()).toBe(session)
      return 'done'
    })

    expect(result).toBe('done')
    expect(__fictGetCurrentSSRSession()).toBeNull()
  })

  it('pops the async session when the callback rejects', async () => {
    const session = __fictCreateSSRSession()

    await expect(
      __fictRunWithSSRSessionAsync(session, async () => {
        await Promise.resolve()
        throw new Error('async failure')
      }),
    ).rejects.toThrow('async failure')

    expect(__fictGetCurrentSSRSession()).toBeNull()
  })

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
