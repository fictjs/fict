import { getDevtoolsHook } from './devtools'

const isDev =
  typeof __DEV__ !== 'undefined'
    ? __DEV__
    : typeof process === 'undefined' || process.env?.NODE_ENV !== 'production'

export interface CycleProtectionOptions {
  /** Enable cycle protection guards (defaults to dev-only) */
  enabled?: boolean
  maxFlushCyclesPerMicrotask?: number
  maxEffectRunsPerFlush?: number
  windowSize?: number
  highUsageRatio?: number
  maxRootReentrantDepth?: number
  enableWindowWarning?: boolean
  devMode?: boolean
  /** Enable backoff warnings at 50% and 75% of limits */
  enableBackoffWarning?: boolean
  /** Ratio at which to show first backoff warning (default 0.5) */
  backoffWarningRatio?: number
}

interface CycleWindowEntry {
  used: number
  budget: number
}

let setCycleProtectionOptions: (opts: CycleProtectionOptions) => void = () => {}
let resetCycleProtectionStateForTests: () => void = () => {}
let beginFlushGuard: () => void = () => {}
let beforeEffectRunGuard: () => boolean = () => true
let endFlushGuard: () => void = () => {}
let enterRootGuard: (root: object) => boolean = () => true
let exitRootGuard: (root: object) => void = () => {}

const defaultOptions = {
  enabled: isDev,
  maxFlushCyclesPerMicrotask: 10_000,
  maxEffectRunsPerFlush: 20_000,
  windowSize: 5,
  highUsageRatio: 0.8,
  maxRootReentrantDepth: 10,
  enableWindowWarning: true,
  devMode: false,
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
let flushWarned = false
let rootWarned = false
let windowWarned = false
// Backoff warning state
let backoffWarned50 = false
let backoffWarned75 = false

setCycleProtectionOptions = opts => {
  if (typeof opts.enabled === 'boolean') {
    enabled = opts.enabled
  }
  options = { ...options, ...opts }
}

resetCycleProtectionStateForTests = () => {
  options = { ...defaultOptions } as Required<CycleProtectionOptions>
  enabled = defaultOptions.enabled
  effectRunsThisFlush = 0
  windowUsage = []
  rootDepth = new WeakMap<object, number>()
  flushWarned = false
  rootWarned = false
  windowWarned = false
  // Reset backoff state
  backoffWarned50 = false
  backoffWarned75 = false
}

beginFlushGuard = () => {
  if (!enabled) return
  effectRunsThisFlush = 0
  flushWarned = false
  windowWarned = false
  // Reset backoff state for new flush
  backoffWarned50 = false
  backoffWarned75 = false
}

beforeEffectRunGuard = () => {
  if (!enabled) return true
  const next = ++effectRunsThisFlush
  const limit = Math.min(options.maxFlushCyclesPerMicrotask, options.maxEffectRunsPerFlush)

  // Backoff warnings at 50% and 75% of limit
  if (options.enableBackoffWarning && isDev) {
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
      console.warn(message, { effectRuns: next, limit })
    }
    return false
  }
  return true
}

endFlushGuard = () => {
  if (!enabled) return
  recordWindowUsage(effectRunsThisFlush, options.maxFlushCyclesPerMicrotask)
  effectRunsThisFlush = 0
}

enterRootGuard = root => {
  if (!enabled) return true
  const depth = (rootDepth.get(root) ?? 0) + 1
  if (depth > options.maxRootReentrantDepth) {
    const message = `[fict] cycle protection triggered: root-reentry`
    if (options.devMode) {
      throw new Error(
        message +
          `\n  - Re-entry depth: ${depth}, Max allowed: ${options.maxRootReentrantDepth}` +
          `\n  - This indicates recursive render() or component initialization.` +
          `\n  - Check for components that trigger re-renders during their own render phase.`,
      )
    }
    if (!rootWarned) {
      rootWarned = true
      console.warn(message, { depth, maxAllowed: options.maxRootReentrantDepth })
    }
    return false
  }
  rootDepth.set(root, depth)
  return true
}

exitRootGuard = root => {
  if (!enabled) return
  const depth = rootDepth.get(root)
  if (depth === undefined) return
  if (depth <= 1) {
    rootDepth.delete(root)
  } else {
    rootDepth.set(root, depth - 1)
  }
}

const recordWindowUsage = (used: number, budget: number): void => {
  if (!options.enableWindowWarning) return
  const entry = { used, budget }
  windowUsage.push(entry)
  if (windowUsage.length > options.windowSize) {
    windowUsage.shift()
  }
  if (windowWarned) return
  if (
    windowUsage.length >= options.windowSize &&
    windowUsage.every(item => item.budget > 0 && item.used / item.budget >= options.highUsageRatio)
  ) {
    windowWarned = true
    reportCycle('high-usage-window', {
      windowSize: options.windowSize,
      ratio: options.highUsageRatio,
    })
  }
}

const reportCycle = (
  reason: string,
  detail: Record<string, unknown> | undefined = undefined,
): void => {
  const hook = getDevtoolsHook()
  hook?.cycleDetected?.(detail ? { reason, detail } : { reason })
  console.warn(`[fict] cycle protection triggered: ${reason}`, detail ?? '')
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
