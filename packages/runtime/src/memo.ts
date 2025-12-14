import { computed } from './signal'
import type { Signal } from './signal'

export type Memo<T> = () => T

export function createMemo<T>(fn: () => T): Memo<T> {
  return computed(fn)
}

export function fromSignal<T>(signal: Signal<T>): Memo<T> {
  return () => signal()
}

export const $memo = createMemo
