import { describe, expect, it } from 'vitest'

import { DelegatedEvents as CompilerDelegatedEvents } from '../src/constants'
import { DelegatedEvents as RuntimeDelegatedEvents } from '../../runtime/src/constants'

describe('DelegatedEvents parity', () => {
  it('runtime and compiler have the same delegated events', () => {
    const runtimeEvents = [...RuntimeDelegatedEvents].sort()
    const compilerEvents = [...CompilerDelegatedEvents].sort()

    expect(runtimeEvents).toEqual(compilerEvents)
  })
})
