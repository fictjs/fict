import { getDevtoolsHook } from './devtools'

const isDev =
  typeof __DEV__ !== 'undefined'
    ? __DEV__
    : typeof process === 'undefined' || process.env?.NODE_ENV !== 'production'

export interface CycleProtectionOptions {
  maxFlushCyclesPerMicrotask?: number
  maxEffectRunsPerFlush?: number
  windowSize?: number
  highUsageRatio?: number
  maxRootReentrantDepth?: number
  enableWindowWarning?: boolean
  devMode?: boolean
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

if (isDev) {
  const defaultOptions = {
    maxFlushCyclesPerMicrotask: 10_000,
    maxEffectRunsPerFlush: 20_000,
    windowSize: 5,
    highUsageRatio: 0.8,
    maxRootReentrantDepth: 10,
    enableWindowWarning: true,
    devMode: false,
  }

  let options: Required<CycleProtectionOptions> = {
    ...defaultOptions,
  } as Required<CycleProtectionOptions>

  let effectRunsThisFlush = 0
  let windowUsage: CycleWindowEntry[] = []
  let rootDepth = new WeakMap<object, number>()
  let flushWarned = false
  let rootWarned = false
  let windowWarned = false

  setCycleProtectionOptions = opts => {
    options = { ...options, ...opts }
  }

  resetCycleProtectionStateForTests = () => {
    options = { ...defaultOptions } as Required<CycleProtectionOptions>
    effectRunsThisFlush = 0
    windowUsage = []
    rootDepth = new WeakMap<object, number>()
    flushWarned = false
    rootWarned = false
    windowWarned = false
  }

  beginFlushGuard = () => {
    effectRunsThisFlush = 0
    flushWarned = false
    windowWarned = false
  }

  beforeEffectRunGuard = () => {
    const next = ++effectRunsThisFlush
    if (next > options.maxFlushCyclesPerMicrotask || next > options.maxEffectRunsPerFlush) {
      const message = `[fict] cycle protection triggered: flush-budget-exceeded`
      if (options.devMode) {
        throw new Error(message)
      }
      if (!flushWarned) {
        flushWarned = true
        console.warn(message, { effectRuns: next })
      }
      return false
    }
    return true
  }

  endFlushGuard = () => {
    recordWindowUsage(effectRunsThisFlush, options.maxFlushCyclesPerMicrotask)
    effectRunsThisFlush = 0
  }

  enterRootGuard = root => {
    const depth = (rootDepth.get(root) ?? 0) + 1
    if (depth > options.maxRootReentrantDepth) {
      const message = `[fict] cycle protection triggered: root-reentry`
      if (options.devMode) {
        throw new Error(message)
      }
      if (!rootWarned) {
        rootWarned = true
        console.warn(message, { depth })
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
      windowUsage.every(
        item => item.budget > 0 && item.used / item.budget >= options.highUsageRatio,
      )
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
