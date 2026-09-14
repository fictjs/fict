import type { Cleanup } from './types'

let owners: WeakMap<PromiseLike<unknown>, () => Cleanup> | undefined

/** First-party resource adapters may transfer a request lease to legacy replay. */
export function __fictOwnSuspenseToken(token: PromiseLike<unknown>, retain: () => Cleanup): void {
  ;(owners ??= new WeakMap()).set(token, retain)
}

export function retainSuspenseToken(token: PromiseLike<unknown>): Cleanup | undefined {
  return owners?.get(token)?.()
}
