import { createRenderBinding, type Effect } from './effect'
import {
  createRootContext,
  destroyRoot,
  getCurrentRoot,
  registerManagedEffectCleanup,
  registerRootCleanup,
  withRootContext,
} from './lifecycle'
import { untrack, type EffectOptions } from './signal'

/**
 * Prepare a complete value before replacing the previous committed effect.
 * Preparation must be synchronous and pure. Read async computations there;
 * commit runs untracked and owns its returned cleanup and nested reactive work.
 */
export function createAsyncEffect<T>(
  prepare: () => T,
  commit: (value: T) => ReturnType<Effect>,
  options?: EffectOptions,
): () => void {
  const root = createRootContext(getCurrentRoot())
  const stop = () => destroyRoot(root)
  registerManagedEffectCleanup(stop)
  if (root.destroyed) return stop

  try {
    withRootContext(root, () =>
      untrack(() => {
        createRenderBinding(
          prepare,
          value => {
            const committed = createRootContext(root)
            try {
              withRootContext(committed, () =>
                untrack(() => {
                  const cleanup = commit(value)
                  if (typeof cleanup === 'function') registerRootCleanup(cleanup)
                }),
              )
            } catch (error) {
              destroyRoot(committed)
              throw error
            }
            return () => destroyRoot(committed)
          },
          options,
        )
      }),
    )
  } catch (error) {
    stop()
    throw error
  }
  return stop
}
