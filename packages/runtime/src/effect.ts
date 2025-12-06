import {
  getCurrentRoot,
  handleError,
  registerRootCleanup,
  runCleanupList,
  withEffectCleanups,
} from './lifecycle'
import { effect } from './signal'
import type { Cleanup } from './types'

export type Effect = () => void | Cleanup

export function createEffect(fn: Effect): () => void {
  let cleanups: Cleanup[] = []
  const rootForError = getCurrentRoot()

  const run = () => {
    runCleanupList(cleanups)
    const bucket: Cleanup[] = []
    withEffectCleanups(bucket, () => {
      try {
        const maybeCleanup = fn()
        if (typeof maybeCleanup === 'function') {
          bucket.push(maybeCleanup)
        }
      } catch (err) {
        if (handleError(err, { source: 'effect' }, rootForError)) {
          return
        }
        throw err
      }
    })
    cleanups = bucket
  }

  const disposeEffect = effect(run)
  const teardown = () => {
    runCleanupList(cleanups)
    disposeEffect()
  }

  registerRootCleanup(teardown)

  return teardown
}

export const $effect = createEffect
