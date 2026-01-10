import { describe, it, expect } from 'vitest'

import { DelegatedEvents as RuntimeDelegatedEvents } from '../src/constants'
import { DelegatedEvents as CompilerDelegatedEvents } from '../../compiler/src/constants'

describe('DelegatedEvents parity', () => {
  it('runtime and compiler have the same delegated events', () => {
    const runtimeEvents = [...RuntimeDelegatedEvents].sort()
    const compilerEvents = [...CompilerDelegatedEvents].sort()

    expect(runtimeEvents).toEqual(compilerEvents)
  })

  it('both sets contain the expected core events', () => {
    const coreEvents = ['click', 'input', 'keydown', 'keyup', 'mousedown', 'mouseup']

    for (const event of coreEvents) {
      expect(RuntimeDelegatedEvents.has(event)).toBe(true)
      expect(CompilerDelegatedEvents.has(event)).toBe(true)
    }
  })

  it('runtime delegated events are non-empty', () => {
    expect(RuntimeDelegatedEvents.size).toBeGreaterThan(0)
  })

  it('compiler delegated events are non-empty', () => {
    expect(CompilerDelegatedEvents.size).toBeGreaterThan(0)
  })
})
