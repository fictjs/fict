function parseFlag(raw: string | undefined): boolean {
  if (!raw) return false
  const val = raw.toLowerCase()
  return val === '1' || val === 'true' || val === 'yes' || val === 'on'
}

/**
 * Unified debug flag check for the compiler.
 * Prefer `FICT_DEBUG=all` or `FICT_DEBUG=flag1,flag2`.
 * For backward compatibility, also honors `DEBUG_<FLAG>` (e.g. DEBUG_REGION=1).
 *
 * Supported flags:
 * - `alias`: Alias tracking and reassignment detection
 * - `region`: Region memo analysis
 * - `cycles`: Cyclic dependency detection
 * - `ssa`: SSA form construction
 * - `all`: Enable all debug output
 */
export function debugEnabled(flag: string): boolean {
  const normalized = flag.toLowerCase()

  // Backward compatibility: DEBUG_<FLAG> and FICT_DEBUG_<FLAG>
  const legacy = process.env[`DEBUG_${flag.toUpperCase()}`]
  if (parseFlag(legacy)) return true

  const fictLegacy = process.env[`FICT_DEBUG_${flag.toUpperCase()}`]
  if (parseFlag(fictLegacy)) return true

  const raw = process.env.FICT_DEBUG ?? process.env.DEBUG_FICT
  if (!raw) return false
  if (parseFlag(raw)) return true

  const parts = raw
    .split(',')
    .map(p => p.trim().toLowerCase())
    .filter(Boolean)

  return parts.includes(normalized) || parts.includes('all')
}

/**
 * Log a debug message if the specified flag is enabled.
 * This is the preferred way to output debug information in the compiler.
 *
 * @param flag - Debug flag to check (e.g., 'alias', 'region', 'cycles')
 * @param message - Message or message factory function
 * @param data - Optional data to log
 */
export function debugLog(flag: string, message: string | (() => string), data?: unknown): void {
  if (!debugEnabled(flag)) return

  const msg = typeof message === 'function' ? message() : message
  const prefix = `[fict:${flag}]`

  if (data !== undefined) {
    console.log(prefix, msg, data)
  } else {
    console.log(prefix, msg)
  }
}

/**
 * Log a debug warning if the specified flag is enabled.
 */
export function debugWarn(flag: string, message: string | (() => string), data?: unknown): void {
  if (!debugEnabled(flag)) return

  const msg = typeof message === 'function' ? message() : message
  const prefix = `[fict:${flag}]`

  if (data !== undefined) {
    console.warn(prefix, msg, data)
  } else {
    console.warn(prefix, msg)
  }
}
