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

  it('retains a non-disableable high-threshold flush guard in production', async () => {
    const mod = await loadCycleGuardForEnv('production')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    mod.resetCycleProtectionStateForTests()
    mod.beginFlushGuard()
    let lastAllowed = false
    for (let run = 0; run < mod.CYCLE_PROTECTION_HARD_LIMITS.effectRunsPerFlush; run++) {
      lastAllowed = mod.beforeEffectRunGuard()
    }
    expect(lastAllowed).toBe(true)
    expect(mod.beforeEffectRunGuard()).toBe(false)
    mod.endFlushGuard()

    expect(warn).toHaveBeenCalledWith('[fict] cycle protection triggered: flush-budget-exceeded', {
      effectRuns: mod.CYCLE_PROTECTION_HARD_LIMITS.effectRunsPerFlush + 1,
      limit: mod.CYCLE_PROTECTION_HARD_LIMITS.effectRunsPerFlush,
      hardLimit: true,
    })
  })

  it('retains a non-disableable root re-entry guard in production', async () => {
    const mod = await loadCycleGuardForEnv('production')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const root = {}

    mod.resetCycleProtectionStateForTests()
    for (let depth = 0; depth < mod.CYCLE_PROTECTION_HARD_LIMITS.rootReentrantDepth; depth++) {
      expect(mod.enterRootGuard(root)).toBe(true)
    }
    expect(mod.enterRootGuard(root)).toBe(false)

    expect(warn).toHaveBeenCalledWith('[fict] cycle protection triggered: root-reentry', {
      depth: mod.CYCLE_PROTECTION_HARD_LIMITS.rootReentrantDepth + 1,
      limit: mod.CYCLE_PROTECTION_HARD_LIMITS.rootReentrantDepth,
      hardLimit: true,
    })

    for (let depth = 0; depth < mod.CYCLE_PROTECTION_HARD_LIMITS.rootReentrantDepth; depth++) {
      mod.exitRootGuard(root)
    }
  })
})
