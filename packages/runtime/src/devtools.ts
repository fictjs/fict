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

const requiredHookMethods = new Set<PropertyKey>([
  'registerSignal',
  'updateSignal',
  'registerComputed',
  'updateComputed',
  'registerEffect',
  'effectRun',
])
const safeHookCache = new WeakMap<FictDevtoolsHook, FictDevtoolsHook>()
const reportedHookFailures = new WeakMap<FictDevtoolsHook, Set<PropertyKey>>()

function reportHookFailure(hook: FictDevtoolsHook, property: PropertyKey, error: unknown): void {
  let reported = reportedHookFailures.get(hook)
  if (!reported) {
    reported = new Set()
    reportedHookFailures.set(hook, reported)
  }
  if (reported.has(property)) return
  reported.add(property)
  try {
    console.error(
      `[fict/devtools] Hook method "${String(property)}" failed; the runtime ignored the error.`,
      error,
    )
  } catch {
    // DevTools diagnostics must never affect application behavior.
  }
}

function readHookProperty(hook: FictDevtoolsHook, property: PropertyKey): unknown {
  try {
    return Reflect.get(hook, property, hook)
  } catch (error) {
    reportHookFailure(hook, property, error)
    return undefined
  }
}

function createSafeHook(hook: FictDevtoolsHook): FictDevtoolsHook {
  const methodCache = new Map<PropertyKey, (...args: unknown[]) => void>()
  const getSafeMethod = (property: PropertyKey): ((...args: unknown[]) => void) => {
    const cached = methodCache.get(property)
    if (cached) return cached
    const safeMethod = (...args: unknown[]) => {
      const method = readHookProperty(hook, property)
      if (typeof method !== 'function') return
      try {
        const result = Reflect.apply(method, hook, args) as unknown
        if (
          result !== null &&
          (typeof result === 'object' || typeof result === 'function') &&
          typeof (result as PromiseLike<unknown>).then === 'function'
        ) {
          void Promise.resolve(result).catch(error => reportHookFailure(hook, property, error))
        }
      } catch (error) {
        reportHookFailure(hook, property, error)
      }
    }
    methodCache.set(property, safeMethod)
    return safeMethod
  }

  return new Proxy({} as FictDevtoolsHook, {
    get(_target, property) {
      if (requiredHookMethods.has(property)) return getSafeMethod(property)
      const cachedMethod = methodCache.get(property)
      if (cachedMethod) return cachedMethod
      const value = readHookProperty(hook, property)
      if (typeof value === 'function') return getSafeMethod(property)
      return value
    },
  })
}

function getGlobalHook(): FictDevtoolsHook | undefined {
  if (typeof globalThis === 'undefined') return undefined
  try {
    const hook = (globalThis as typeof globalThis & { __FICT_DEVTOOLS_HOOK__?: unknown })
      .__FICT_DEVTOOLS_HOOK__
    if (hook !== null && (typeof hook === 'object' || typeof hook === 'function')) {
      return hook as FictDevtoolsHook
    }
  } catch {
    // A malformed global observer must behave as if DevTools were absent.
  }
  return undefined
}

export function isDevtoolsHookCompatible(hook: FictDevtoolsHook): boolean {
  const compatibility = hook.devtools
  if (!compatibility) {
    return true
  }

  return (
    compatibility.minRuntimeProtocol <= FICT_DEVTOOLS_PROTOCOL_VERSION &&
    compatibility.maxRuntimeProtocol >= FICT_DEVTOOLS_PROTOCOL_VERSION
  )
}

export function getDevtoolsHook(): FictDevtoolsHook | undefined {
  const hook = getGlobalHook()
  if (!hook || !isDevtoolsHookCompatible(hook)) return undefined
  return hook
}

/** Internal observer-safe facade. Public consumers should use getDevtoolsHook(). */
export function getSafeDevtoolsHook(): FictDevtoolsHook | undefined {
  let hook: FictDevtoolsHook | undefined
  try {
    hook = getDevtoolsHook()
  } catch (error) {
    const candidate = getGlobalHook()
    if (candidate) reportHookFailure(candidate, 'compatibility', error)
    return undefined
  }
  if (!hook) return undefined

  const cached = safeHookCache.get(hook)
  if (cached) return cached
  const safeHook = createSafeHook(hook)
  safeHookCache.set(hook, safeHook)
  return safeHook
}
