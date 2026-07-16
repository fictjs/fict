import { describe, it, expect } from 'vitest'

import runtimeAbi from '../runtime-abi.json'
import { DelegatedEvents as RuntimeDelegatedEvents } from '../src/constants'

describe('DelegatedEvents parity', () => {
  it('runtime and generated compiler ABI have the same delegated events', () => {
    const runtimeEvents = [...RuntimeDelegatedEvents].sort()
    const compilerEvents = [...runtimeAbi.delegatedEvents].sort()

    expect(runtimeEvents).toEqual(compilerEvents)
  })

  it('both sets contain the expected core events', () => {
    const coreEvents = ['click', 'input', 'keydown', 'keyup', 'mousedown', 'mouseup']

    for (const event of coreEvents) {
      expect(RuntimeDelegatedEvents.has(event)).toBe(true)
      expect(runtimeAbi.delegatedEvents).toContain(event)
    }
  })

  it('runtime delegated events are non-empty', () => {
    expect(RuntimeDelegatedEvents.size).toBeGreaterThan(0)
  })

  it('compiler ABI delegated events are non-empty', () => {
    expect(runtimeAbi.delegatedEvents.length).toBeGreaterThan(0)
  })
})
