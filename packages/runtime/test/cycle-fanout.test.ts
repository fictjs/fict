import { afterEach, expect, it, vi } from 'vitest'

import { batch, createEffect } from '../src/index'
import { createSignal } from '../src/advanced'
import { resetCycleProtectionStateForTests, setCycleProtectionOptions } from '../src/cycle-guard'

afterEach(() => {
  resetCycleProtectionStateForTests()
  vi.restoreAllMocks()
})

it.each([true, false])('completes acyclic fan-out beyond the old flush ceiling (dev=%s)', dev => {
  resetCycleProtectionStateForTests()
  setCycleProtectionOptions({ enabled: dev, devMode: dev })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const source = createSignal(0)
  const count = dev ? 10_001 : 100_001
  const observed = new Uint8Array(count)
  const stops: (() => void)[] = []
  try {
    for (let index = 0; index < count; index++) {
      stops.push(
        createEffect(() => {
          observed[index] = source()
        }),
      )
    }
    batch(() => source(1))
    expect(observed.every(value => value === 1)).toBe(true)
    expect(warn).not.toHaveBeenCalled()
  } finally {
    stops.forEach(stop => stop())
  }
})
