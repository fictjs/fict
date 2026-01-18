import {
  getCurrentRoot,
  handleError,
  handleSuspend,
  registerRootCleanup,
  runCleanupList,
  withEffectCleanups,
} from './lifecycle'
import { effectWithCleanup } from './signal'
import type { Cleanup } from './types'

/**
 * Effect callback run synchronously; async callbacks are not tracked after the first await.
 * TypeScript will reject `async () => {}` here—split async work or read signals before awaiting.
 */
export type Effect = () => void | Cleanup

export function createEffect(fn: Effect): () => void {
  let cleanups: Cleanup[] = []
  const rootForError = getCurrentRoot()

  // Cleanup runner - called by runEffect BEFORE signal values are committed
  const doCleanup = () => {
    runCleanupList(cleanups)
    cleanups = []
  }

  const run = () => {
    // Note: cleanups are now run by signal.ts runEffect before this function is called
    const bucket: Cleanup[] = []
    withEffectCleanups(bucket, () => {
      try {
        const maybeCleanup = fn()
        if (typeof maybeCleanup === 'function') {
          bucket.push(maybeCleanup)
        }
      } catch (err) {
        if (handleSuspend(err as any, rootForError)) {
          return
        }
        if (handleError(err, { source: 'effect' }, rootForError)) {
          return
        }
        throw err
      }
    })
    cleanups = bucket
  }

  const disposeEffect = effectWithCleanup(run, doCleanup, rootForError)
  const teardown = () => {
    runCleanupList(cleanups)
    disposeEffect()
  }

  registerRootCleanup(teardown)

  return teardown
}

export const $effect = createEffect

export function createRenderEffect(fn: Effect): () => void {
  let cleanup: Cleanup | undefined
  const rootForError = getCurrentRoot()

  // Cleanup runner - called by runEffect BEFORE signal values are committed
  const doCleanup = () => {
    if (cleanup) {
      cleanup()
      cleanup = undefined
    }
  }

  const run = () => {
    // Note: cleanups are now run by signal.ts runEffect before this function is called
    try {
      const maybeCleanup = fn()
      if (typeof maybeCleanup === 'function') {
        cleanup = maybeCleanup
      }
    } catch (err) {
      if (handleSuspend(err as any, rootForError)) {
        return
      }
      const handled = handleError(err, { source: 'effect' }, rootForError)
      if (handled) {
        return
      }
      throw err
    }
  }

  const disposeEffect = effectWithCleanup(run, doCleanup, rootForError)
  const teardown = () => {
    if (cleanup) {
      cleanup()
      cleanup = undefined
    }
    disposeEffect()
  }

  registerRootCleanup(teardown)

  return teardown
}
