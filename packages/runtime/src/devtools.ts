export interface FictDevtoolsHook {
  registerSignal: (
    id: number,
    value: unknown,
    options?: { name?: string; source?: string; ownerId?: number },
  ) => void
  updateSignal: (id: number, value: unknown) => void
  registerComputed: (
    id: number,
    value: unknown,
    options?: { name?: string; source?: string; ownerId?: number; hasValue?: boolean },
  ) => void
  updateComputed: (id: number, value: unknown) => void
  registerEffect: (id: number, options?: { ownerId?: number; source?: string }) => void
  effectRun: (id: number) => void
  /** Track a dependency relationship between subscriber and dependency */
  trackDependency?: (subscriberId: number, dependencyId: number) => void
  /** Remove a dependency relationship when unlinked */
  untrackDependency?: (subscriberId: number, dependencyId: number) => void
  cycleDetected?: (payload: { reason: string; detail?: Record<string, unknown> }) => void

  // Component lifecycle
  registerComponent?: (id: number, name: string, parentId?: number, source?: any) => void
  componentMount?: (id: number, elements?: HTMLElement[]) => void
  componentUnmount?: (id: number) => void
  componentRender?: (id: number) => void
}

function getGlobalHook(): FictDevtoolsHook | undefined {
  if (typeof globalThis === 'undefined') return undefined
  return (globalThis as typeof globalThis & { __FICT_DEVTOOLS_HOOK__?: FictDevtoolsHook })
    .__FICT_DEVTOOLS_HOOK__
}

export function getDevtoolsHook(): FictDevtoolsHook | undefined {
  return getGlobalHook()
}
