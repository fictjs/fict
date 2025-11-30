export function batch<T>(fn: () => T): T {
  return fn()
}

export function untrack<T>(fn: () => T): T {
  return fn()
}
