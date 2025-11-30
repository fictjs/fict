import type { Cleanup } from './effect'

type LifecycleFn = () => void | Cleanup

export function onMount(fn: LifecycleFn): void {
  fn()
}

export function onDestroy(fn: LifecycleFn): void {
  fn()
}

export function onCleanup(fn: Cleanup): void {
  fn()
}
