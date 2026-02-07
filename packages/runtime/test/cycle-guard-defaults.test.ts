import { afterEach, describe, expect, it, vi } from 'vitest'

type CycleGuardModule = typeof import('../src/cycle-guard')

async function loadCycleGuardForEnv(nodeEnv: string): Promise<CycleGuardModule> {
  const previousEnv = process.env.NODE_ENV
  process.env.NODE_ENV = nodeEnv
  vi.resetModules()
  const mod = await import('../src/cycle-guard')
  process.env.NODE_ENV = previousEnv
  return mod
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('cycle guard defaults', () => {
  it('enables guards by default in development', async () => {
    const mod = await loadCycleGuardForEnv('development')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    mod.resetCycleProtectionStateForTests()
    mod.setCycleProtectionOptions({
      maxFlushCyclesPerMicrotask: 1,
      maxEffectRunsPerFlush: 1,
      devMode: false,
    })

    mod.beginFlushGuard()
    expect(mod.beforeEffectRunGuard()).toBe(true)
    expect(mod.beforeEffectRunGuard()).toBe(false)
    mod.endFlushGuard()

    expect(
      warn.mock.calls.some(
        ([msg]) => typeof msg === 'string' && msg.includes('flush-budget-exceeded'),
      ),
    ).toBe(true)
  })

  it('disables guards by default in production', async () => {
    const mod = await loadCycleGuardForEnv('production')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    mod.resetCycleProtectionStateForTests()
    mod.beginFlushGuard()
    expect(mod.beforeEffectRunGuard()).toBe(true)
    expect(mod.beforeEffectRunGuard()).toBe(true)
    expect(mod.beforeEffectRunGuard()).toBe(true)
    mod.endFlushGuard()

    expect(warn).not.toHaveBeenCalled()
  })
})
