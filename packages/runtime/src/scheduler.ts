import { batch as baseBatch, untrack as baseUntrack } from './signal'

export function batch<T>(fn: () => T): T {
  return baseBatch(fn)
}

export function untrack<T>(fn: () => T): T {
  return baseUntrack(fn)
}
