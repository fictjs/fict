import { createSignal } from './signal'

export interface VersionedSignalOptions<T> {
  equals?: (prev: T, next: T) => boolean
}

export interface VersionedSignal<T> {
  /** Reactive read that tracks both the value and version counter */
  read: () => T
  /** Write a new value, forcing a version bump when value is equal */
  write: (next: T) => void
  /** Force a version bump without changing the value */
  force: () => void
  /** Read the current version without creating a dependency */
  peekVersion: () => number
  /** Read the current value without tracking */
  peekValue: () => T
}

/**
 * Create a signal wrapper that forces subscribers to update when the same reference is written.
 *
 * Useful for compiler-generated keyed list items where updates may reuse the same object reference.
 */
export function createVersionedSignal<T>(
  initialValue: T,
  options?: VersionedSignalOptions<T>,
): VersionedSignal<T> {
  const equals = options?.equals ?? Object.is
  const value = createSignal(initialValue)
  const version = createSignal(0)

  const bumpVersion = () => {
    const next = version() + 1
    version(next)
  }

  return {
    read: () => {
      // Track both version and value to ensure equal writes notify subscribers
      version()
      return value()
    },
    write: (next: T) => {
      const prev = value()
      if (!equals(prev, next)) {
        value(next)
        return
      }
      bumpVersion()
    },
    force: () => {
      bumpVersion()
    },
    peekVersion: () => version(),
    peekValue: () => value(),
  }
}
