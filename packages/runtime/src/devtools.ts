export const FICT_DEVTOOLS_PROTOCOL_VERSION = 1
export const FICT_DEVTOOLS_MIN_PROTOCOL_VERSION = 1

export interface FictDevtoolsCompatibility {
  /** DevTools hook protocol implemented by the installed hook. */
  protocolVersion: number
  /** Lowest runtime hook protocol accepted by this DevTools hook. */
  minRuntimeProtocol: number
  /** Highest runtime hook protocol accepted by this DevTools hook. */
  maxRuntimeProtocol: number
}

export interface FictDevtoolsHook {
  readonly devtools?: FictDevtoolsCompatibility
  registerSignal: (
    id: number,
    value: unknown,
    options?: { name?: string; source?: string; ownerId?: number },
  ) => void
  updateSignal: (id: number, value: unknown) => void
  disposeSignal?: (id: number) => void
  registerComputed: (
    id: number,
    value: unknown,
    options?: {
      name?: string
      source?: string
      ownerId?: number
      hasValue?: boolean
      internal?: boolean
    },
  ) => void
  updateComputed: (id: number, value: unknown) => void
  disposeComputed?: (id: number) => void
  registerEffect: (id: number, options?: { ownerId?: number; source?: string }) => void
  effectRun: (id: number, duration?: number) => void
  effectCleanup?: (id: number) => void
  disposeEffect?: (id: number) => void
  /** Track a dependency relationship between subscriber and dependency */
  trackDependency?: (subscriberId: number, dependencyId: number) => void
  /** Remove a dependency relationship when unlinked */
  untrackDependency?: (subscriberId: number, dependencyId: number) => void
  registerRoot?: (id: number, name?: string) => void
  disposeRoot?: (id: number) => void
  rootSuspend?: (id: number, suspended: boolean) => void
  batchStart?: () => void
  batchEnd?: () => void
  flushStart?: () => void
  flushEnd?: () => void
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

export function isDevtoolsHookCompatible(hook: FictDevtoolsHook): boolean {
  const compatibility = hook.devtools
  if (!compatibility) {
    return true
  }

  return (
    compatibility.minRuntimeProtocol <= FICT_DEVTOOLS_PROTOCOL_VERSION &&
    compatibility.maxRuntimeProtocol >= FICT_DEVTOOLS_MIN_PROTOCOL_VERSION
  )
}

export function getDevtoolsHook(): FictDevtoolsHook | undefined {
  const hook = getGlobalHook()
  if (!hook || !isDevtoolsHookCompatible(hook)) return undefined
  return hook
}
