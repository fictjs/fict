import { isReactive, type MaybeReactive } from './binding'
import { createEffect } from './effect'
import {
  createRootContext,
  destroyRoot,
  flushOnMount,
  getCurrentRoot,
  onCleanup,
  popRoot,
  pushRoot,
  registerRootCleanup,
  type RootContext,
} from './lifecycle'
import { untrack } from './signal'

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
  const owner = getCurrentRoot()
  let activeRoot: RootContext | undefined
  let generation = 0

  const stop = () => {
    generation++
    const root = activeRoot
    activeRoot = undefined
    if (root) destroyRoot(root)
  }

  const run = <T>(fn: () => T): T => {
    const currentGeneration = ++generation
    const previousRoot = activeRoot
    activeRoot = undefined
    if (previousRoot) destroyRoot(previousRoot)

    const root = createRootContext(owner)
    const isCurrent = () =>
      generation === currentGeneration && !owner?.destroying && !owner?.destroyed
    if (isCurrent()) activeRoot = root
    else destroyRoot(root)

    let completed = false
    const previous = pushRoot(root)
    try {
      let value: T
      try {
        value = untrack(fn)
      } finally {
        popRoot(previous)
      }
      flushOnMount(root)
      completed = true
      return value
    } finally {
      if (!completed || !isCurrent()) {
        if (activeRoot === root) activeRoot = undefined
        destroyRoot(root)
      }
    }
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
