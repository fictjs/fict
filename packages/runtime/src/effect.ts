export type Cleanup = () => void
export type Effect = () => void | Cleanup

export function createEffect(fn: Effect): void {
  const cleanup = fn()
  if (typeof cleanup === 'function') {
    // no-op placeholder to keep cleanup reachable for future scheduler integration
  }
}

export const $effect = createEffect
