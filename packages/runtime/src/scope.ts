import { isReactive, type MaybeReactive } from './binding'
import { createEffect } from './effect'
import { createRoot, onCleanup, registerRootCleanup } from './lifecycle'

export { effectScope } from './signal'

export interface ReactiveScope {
  run<T>(fn: () => T): T
  stop(): void
}

/**
 * Create an explicit reactive scope that can contain effects/memos and be stopped manually.
 * The scope registers with the current root for cleanup.
 */
export function createScope(): ReactiveScope {
  let dispose: (() => void) | null = null

  const stop = () => {
    if (dispose) {
      dispose()
      dispose = null
    }
  }

  const run = <T>(fn: () => T): T => {
    stop()
    const { dispose: rootDispose, value } = createRoot(fn)
    dispose = rootDispose
    return value
  }

  registerRootCleanup(stop)
  return { run, stop }
}

/**
 * Run a block of reactive code inside a managed scope that follows a boolean flag.
 * When the flag turns false, the scope is disposed and all contained effects/memos are cleaned up.
 */
export function runInScope(flag: MaybeReactive<boolean>, fn: () => void): void {
  const scope = createScope()
  const evaluate = () => (isReactive(flag) ? (flag as () => boolean)() : !!flag)

  createEffect(() => {
    const enabled = evaluate()
    if (enabled) {
      scope.run(fn)
    } else {
      scope.stop()
    }
  })

  onCleanup(scope.stop)
}
