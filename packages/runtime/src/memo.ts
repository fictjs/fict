import { computed, type Signal, type MemoOptions } from './signal'

export type Memo<T> = () => T

export function createMemo<T>(fn: () => T, options?: MemoOptions<T>): Memo<T> {
  return computed(fn, options)
}

export function fromSignal<T>(signal: Signal<T>): Memo<T> {
  return () => signal()
}

export const $memo = createMemo
