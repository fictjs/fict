function parseFlag(raw: string | undefined): boolean {
  if (!raw) return false
  const val = raw.toLowerCase()
  return val === '1' || val === 'true' || val === 'yes' || val === 'on'
}

/**
 * Unified debug flag check for the compiler.
 * Prefer `FICT_DEBUG=all` or `FICT_DEBUG=flag1,flag2`.
 * For backward compatibility, also honors `DEBUG_<FLAG>` (e.g. DEBUG_REGION=1).
 */
export function debugEnabled(flag: string): boolean {
  const normalized = flag.toLowerCase()

  // Backward compatibility: DEBUG_<FLAG>
  const legacy = process.env[`DEBUG_${flag.toUpperCase()}`]
  if (parseFlag(legacy)) return true

  const raw = process.env.FICT_DEBUG ?? process.env.DEBUG_FICT
  if (!raw) return false
  if (parseFlag(raw)) return true

  const parts = raw
    .split(',')
    .map(p => p.trim().toLowerCase())
    .filter(Boolean)

  return parts.includes(normalized) || parts.includes('all')
}
