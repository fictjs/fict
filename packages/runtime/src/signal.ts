export type Signal<T> = T

export function createSignal<T>(initial: T): Signal<T> {
  return initial
}

export const $state = createSignal
