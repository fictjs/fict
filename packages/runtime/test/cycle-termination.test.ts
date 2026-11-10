import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.resetModules()
})

it('terminates a dev-mode feedback loop instead of rescheduling it after throwing', async () => {
  const tasks: VoidFunction[] = []
  vi.stubGlobal('queueMicrotask', (callback: VoidFunction) => tasks.push(callback))
  vi.resetModules()
  const { createEffect, batch } = await import('../src/index')
  const { createSignal } = await import('../src/advanced')
  const { setCycleProtectionOptions } = await import('../src/cycle-guard')
  setCycleProtectionOptions({
    maxEffectRunsPerFlush: 5,
    devMode: true,
    enableBackoffWarning: false,
  })
  const source = createSignal(0)
  let runs = 0
  const dispose = createEffect(() => {
    runs++
    if (source() > 0) source(source() + 1)
  })
  try {
    expect(() => batch(() => source(1))).toThrow(/flush-budget-exceeded/)
    const stoppedAt = runs
    for (const callback of tasks.splice(0)) expect(callback).not.toThrow()
    expect(runs).toBe(stoppedAt)
    expect(tasks).toHaveLength(0)
  } finally {
    dispose()
  }
})
