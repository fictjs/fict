import { stripBasePath } from './utils'

const isDevEnv =
  (typeof import.meta !== 'undefined' &&
    (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true) ||
  (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production')

let didWarnBaseMismatch = false

function hasBasePrefix(pathname: string, base: string): boolean {
  if (!base) return true
  return pathname === base || pathname.startsWith(base + '/')
}

export function stripBaseOrWarn(pathname: string, base: string): string | null {
  if (!base) return pathname
  if (!hasBasePrefix(pathname, base)) {
    if (isDevEnv && !didWarnBaseMismatch) {
      didWarnBaseMismatch = true
      console.warn(
        `[fict-router] Location "${pathname}" does not start with base "${base}". No routes matched.`,
      )
    }
    return null
  }
  return stripBasePath(pathname, base)
}

export function stripBaseIfPresent(pathname: string, base: string): string {
  if (!base) return pathname
  if (!hasBasePrefix(pathname, base)) return pathname
  return stripBasePath(pathname, base)
}
