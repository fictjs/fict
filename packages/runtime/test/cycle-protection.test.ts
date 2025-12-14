import { describe, it, expect, afterEach, vi } from 'vitest'

import { createEffect, createSignal } from '../src'
import { resetCycleProtectionStateForTests, setCycleProtectionOptions } from '../src/cycle-guard'
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
})
