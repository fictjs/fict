/**
 * Change detection for boundary `resetKeys` props (ErrorBoundary, Suspense).
 *
 * Compiled prop accessors re-evaluate their expression on every access, so an
 * array literal like `resetKeys={[id]}` yields a fresh array each time the
 * watching effect runs. Arrays are therefore compared element-wise; everything
 * else falls back to reference equality.
 */
export function resetKeysChanged(prev: unknown, next: unknown): boolean {
  if (prev === next) return false
  if (Array.isArray(prev) && Array.isArray(next)) {
    if (prev.length !== next.length) return true
    for (let i = 0; i < prev.length; i++) {
      if (prev[i] !== next[i]) return true
    }
    return false
  }
  return true
}
