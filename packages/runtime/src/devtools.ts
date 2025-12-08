export interface FictDevtoolsHook {
  registerSignal: (id: number, value: unknown) => void
  updateSignal: (id: number, value: unknown) => void
  registerEffect: (id: number) => void
  effectRun: (id: number) => void
  cycleDetected?: (payload: { reason: string; detail?: Record<string, unknown> }) => void
}

function getGlobalHook(): FictDevtoolsHook | undefined {
  if (typeof globalThis === 'undefined') return undefined
  return (globalThis as typeof globalThis & { __FICT_DEVTOOLS_HOOK__?: FictDevtoolsHook })
    .__FICT_DEVTOOLS_HOOK__
}

export function getDevtoolsHook(): FictDevtoolsHook | undefined {
  return getGlobalHook()
}
