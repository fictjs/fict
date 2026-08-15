import { getSafeDevtoolsHook as getDevtoolsHook } from './devtools'

const isDev =
  typeof __DEV__ !== 'undefined'
    ? __DEV__
    : typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production'

export interface CycleProtectionOptions {
  /** Enable configurable guards and warnings. Immutable hard limits always remain active. */
  enabled?: boolean
  maxFlushCyclesPerMicrotask?: number
  maxEffectRunsPerFlush?: number
  windowSize?: number
  highUsageRatio?: number
  maxRootReentrantDepth?: number
  enableWindowWarning?: boolean
  devMode?: boolean
  /** Enable backoff warnings before the configurable effect-run limit */
  enableBackoffWarning?: boolean
  /** Ratio at which to show first backoff warning (default 0.5) */
  backoffWarningRatio?: number
}

interface CycleWindowEntry {
  used: number
  budget: number
}

const HARD_EFFECT_RUNS = 100_000
const HARD_ROOT_DEPTH = 100
const HARD_WINDOW_SIZE = 100

/** Non-disableable ceilings that keep production from spinning indefinitely. */
export const CYCLE_PROTECTION_HARD_LIMITS = Object.freeze({
  effectRunsPerFlush: HARD_EFFECT_RUNS,
  rootReentrantDepth: HARD_ROOT_DEPTH,
  windowSize: HARD_WINDOW_SIZE,
})

let setCycleProtectionOptions: (opts: CycleProtectionOptions) => void = () => {}
let resetCycleProtectionStateForTests: () => void = () => {}
let beginFlushGuard: () => void = () => {}
let beforeEffectRunGuard: () => boolean = () => true
let endFlushGuard: () => void = () => {}
let enterRootGuard: (root: object) => boolean = () => true
let exitRootGuard: (root: object) => void = () => {}

const defaultOptions = {
  // Configurable diagnostics remain DX-first. The hard tier below is always active.
  enabled: isDev,
  maxFlushCyclesPerMicrotask: 10_000,
  maxEffectRunsPerFlush: 20_000,
  windowSize: 5,
  highUsageRatio: 0.8,
  maxRootReentrantDepth: 10,
  enableWindowWarning: true,
  devMode: isDev,
  // Backoff warning options
  enableBackoffWarning: isDev,
  backoffWarningRatio: 0.5,
}

let enabled = defaultOptions.enabled
let options: Required<CycleProtectionOptions> = {
  ...defaultOptions,
} as Required<CycleProtectionOptions>

let effectRunsThisFlush = 0
let windowUsage: CycleWindowEntry[] = []
let rootDepth = new WeakMap<object, number>()
let warnedRoots = new WeakSet<object>()
let flushWarned = false
let windowWarned = false
// Backoff warning state
let backoffWarned50 = false
let backoffWarned75 = false

setCycleProtectionOptions = opts => {
  if (typeof opts.enabled === 'boolean') {
    enabled = opts.enabled
  }
  if (opts.enabled === false || opts.enableWindowWarning === false) {
    windowUsage = []
    windowWarned = false
  }
  options = { ...options, ...opts }
}

resetCycleProtectionStateForTests = () => {
  options = { ...defaultOptions } as Required<CycleProtectionOptions>
  enabled = defaultOptions.enabled
  effectRunsThisFlush = 0
  windowUsage = []
  rootDepth = new WeakMap<object, number>()
  warnedRoots = new WeakSet<object>()
  flushWarned = false
  windowWarned = false
  // Reset backoff state
  backoffWarned50 = false
  backoffWarned75 = false
}

beginFlushGuard = () => {
  effectRunsThisFlush = 0
  flushWarned = false
  // Reset backoff state for new flush
  backoffWarned50 = false
  backoffWarned75 = false
}

beforeEffectRunGuard = () => {
  const next = ++effectRunsThisFlush
  const limit = effectiveEffectRunLimit()

  // Backoff warnings at 50% and 75% of limit
  if (enabled && options.enableBackoffWarning && isDev) {
    const ratio = next / limit
    const backoffRatio = options.backoffWarningRatio ?? 0.5

    if (!backoffWarned50 && ratio >= backoffRatio && ratio < backoffRatio + 0.25) {
      backoffWarned50 = true
      console.warn(
        `[fict] cycle guard: approaching effect limit (${Math.round(ratio * 100)}% of budget used)\n` +
          `  - Current: ${next} effects, Limit: ${limit}\n` +
          `  - Tip: Check for effects that trigger other effects in a loop.\n` +
          `  - Common causes: signal updates inside effects that read and write the same signal.`,
      )
    } else if (!backoffWarned75 && ratio >= backoffRatio + 0.25 && ratio < 1) {
      backoffWarned75 = true
      console.warn(
        `[fict] cycle guard: nearing effect limit (${Math.round(ratio * 100)}% of budget used)\n` +
          `  - Current: ${next} effects, Limit: ${limit}\n` +
          `  - Warning: Consider breaking the reactive dependency cycle.\n` +
          `  - Debug: Use browser devtools to identify the recursive effect chain.`,
      )
    }
  }

  if (next > limit) {
    const message = `[fict] cycle protection triggered: flush-budget-exceeded`
    if (options.devMode) {
      throw new Error(
        message +
          `\n  - Effect runs: ${next}, Limit: ${limit}` +
          `\n  - This indicates a reactive cycle where effects keep triggering each other.` +
          `\n  - Check for patterns like: createEffect(() => { signal(); signal(newValue); })`,
      )
    }
    if (!flushWarned) {
      flushWarned = true
      reportCycle('flush-budget-exceeded', {
        effectRuns: next,
        limit,
        hardLimit: limit === HARD_EFFECT_RUNS,
      })
    }
    return false
  }
  return true
}

endFlushGuard = () => {
  if (enabled) {
    recordWindowUsage(effectRunsThisFlush, effectiveEffectRunLimit())
  }
  effectRunsThisFlush = 0
}

enterRootGuard = root => {
  const depth = (rootDepth.get(root) ?? 0) + 1
  const limit = effectiveRootReentrantLimit()
  if (depth > limit) {
    const message = `[fict] cycle protection triggered: root-reentry`
    if (options.devMode) {
      throw new Error(
        message +
          `\n  - Re-entry depth: ${depth}, Max allowed: ${limit}` +
          `\n  - This indicates recursive render() or component initialization.` +
          `\n  - Check for components that trigger re-renders during their own render phase.`,
      )
    }
    if (!warnedRoots.has(root)) {
      warnedRoots.add(root)
      reportCycle('root-reentry', {
        depth,
        limit,
        hardLimit: limit === HARD_ROOT_DEPTH,
      })
    }
    return false
  }
  rootDepth.set(root, depth)
  return true
}

exitRootGuard = root => {
  const depth = rootDepth.get(root)
  if (depth === undefined) return
  if (depth <= 1) {
    rootDepth.delete(root)
    warnedRoots.delete(root)
  } else {
    rootDepth.set(root, depth - 1)
  }
}

const recordWindowUsage = (used: number, budget: number): void => {
  if (!options.enableWindowWarning) return
  const windowSize = boundedInteger(options.windowSize, 1, HARD_WINDOW_SIZE)
  const highUsageRatio = boundedRatio(options.highUsageRatio, defaultOptions.highUsageRatio)
  const entry = { used, budget }
  windowUsage.push(entry)
  if (windowUsage.length > windowSize) {
    windowUsage.shift()
  }
  const sustained =
    windowUsage.length >= windowSize &&
    windowUsage.every(item => item.budget > 0 && item.used / item.budget >= highUsageRatio)
  if (!sustained) {
    windowWarned = false
  } else if (!windowWarned) {
    windowWarned = true
    reportCycle('high-usage-window', {
      windowSize,
      ratio: highUsageRatio,
    })
  }
}

const effectiveEffectRunLimit = (): number => {
  if (!enabled) return HARD_EFFECT_RUNS
  return Math.min(
    boundedInteger(options.maxFlushCyclesPerMicrotask, 0, HARD_EFFECT_RUNS),
    boundedInteger(options.maxEffectRunsPerFlush, 0, HARD_EFFECT_RUNS),
  )
}

const effectiveRootReentrantLimit = (): number =>
  enabled ? boundedInteger(options.maxRootReentrantDepth, 0, HARD_ROOT_DEPTH) : HARD_ROOT_DEPTH

const boundedInteger = (value: number, minimum: number, maximum: number): number => {
  if (!Number.isFinite(value)) return maximum
  return Math.min(maximum, Math.max(minimum, Math.floor(value)))
}

const boundedRatio = (value: number, fallback: number): number =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback

const reportCycle = (
  reason: string,
  detail: Record<string, unknown> | undefined = undefined,
): void => {
  const hook = getDevtoolsHook()
  hook?.cycleDetected?.(detail ? { reason, detail } : { reason })
  try {
    console.warn(`[fict] cycle protection triggered: ${reason}`, detail ?? '')
  } catch {
    // Console shims must never weaken the hard guard.
  }
}

export {
  setCycleProtectionOptions,
  resetCycleProtectionStateForTests,
  beginFlushGuard,
  beforeEffectRunGuard,
  endFlushGuard,
  enterRootGuard,
  exitRootGuard,
}
