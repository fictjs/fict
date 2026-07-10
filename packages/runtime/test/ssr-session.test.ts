import { AsyncLocalStorage } from 'node:async_hooks'

import { describe, expect, it } from 'vitest'

import {
  __fictCreateSSRSession,
  __fictGetCurrentSSRSession,
  __fictInstallSSRSessionCarrier,
  __fictIsSSRSessionActive,
  __fictRunWithSSRSession,
  type FictSSRSession,
} from '../src/internal'

describe('SSR session stack', () => {
  it('fails closed when the fallback stack cannot cross an await', async () => {
    const session = __fictCreateSSRSession()
    let sessionDuringSyncCall: unknown
    let sessionAfterAwait: unknown

    const promise = __fictRunWithSSRSession(session, async () => {
      sessionDuringSyncCall = __fictGetCurrentSSRSession()
      await Promise.resolve()
      sessionAfterAwait = __fictGetCurrentSSRSession()
    })

    expect(__fictGetCurrentSSRSession()).toBeNull()
    expect(__fictIsSSRSessionActive()).toBe(true)

    await promise

    expect(sessionDuringSyncCall).toBe(session)
    expect(sessionAfterAwait).toBeNull()
    expect(__fictGetCurrentSSRSession()).toBeNull()
    expect(__fictIsSSRSessionActive()).toBe(false)
  })

  it('preserves isolated sessions across awaits with an async carrier', async () => {
    const storage = new AsyncLocalStorage<FictSSRSession>()
    const restore = __fictInstallSSRSessionCarrier({
      getStore: () => storage.getStore(),
      run: (session, fn) => storage.run(session, fn),
    })
    const alice = __fictCreateSSRSession()
    const bob = __fictCreateSSRSession()
    let releaseAlice!: () => void
    let releaseBob!: () => void
    const aliceGate = new Promise<void>(resolve => {
      releaseAlice = resolve
    })
    const bobGate = new Promise<void>(resolve => {
      releaseBob = resolve
    })

    try {
      const aliceRun = __fictRunWithSSRSession(alice, async () => {
        expect(__fictGetCurrentSSRSession()).toBe(alice)
        await aliceGate
        return __fictGetCurrentSSRSession()
      })
      const bobRun = __fictRunWithSSRSession(bob, async () => {
        expect(__fictGetCurrentSSRSession()).toBe(bob)
        await bobGate
        return __fictGetCurrentSSRSession()
      })

      expect(__fictGetCurrentSSRSession()).toBeNull()
      releaseBob()
      releaseAlice()

      const [aliceAfterAwait, bobAfterAwait] = await Promise.all([aliceRun, bobRun])
      expect(aliceAfterAwait).toBe(alice)
      expect(bobAfterAwait).toBe(bob)
      expect(aliceAfterAwait).not.toBe(bobAfterAwait)
      expect(__fictIsSSRSessionActive()).toBe(false)
    } finally {
      restore()
    }
  })

  it('returns a tracked rejection and releases the active session', async () => {
    const failure = new Error('session failed')
    const original = Promise.reject(failure)
    const tracked = __fictRunWithSSRSession(__fictCreateSSRSession(), () => original)

    expect(tracked).not.toBe(original)
    expect(__fictIsSSRSessionActive()).toBe(true)
    await expect(tracked).rejects.toBe(failure)
    expect(__fictIsSSRSessionActive()).toBe(false)
  })

  it('does not revive a restored carrier after out-of-order cleanup', () => {
    const alice = __fictCreateSSRSession()
    const bob = __fictCreateSSRSession()
    const restoreAlice = __fictInstallSSRSessionCarrier({
      getStore: () => alice,
      run: (_session, fn) => fn(),
    })
    const restoreBob = __fictInstallSSRSessionCarrier({
      getStore: () => bob,
      run: (_session, fn) => fn(),
    })

    expect(__fictGetCurrentSSRSession()).toBe(bob)
    restoreAlice()
    expect(__fictGetCurrentSSRSession()).toBe(bob)
    restoreBob()
    expect(__fictGetCurrentSSRSession()).toBeNull()
  })
})
