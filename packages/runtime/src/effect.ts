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

export function createRenderEffect(fn: Effect): () => void {
  let cleanup: Cleanup | undefined
  const rootForError = getCurrentRoot()

  const run = () => {
    if (cleanup) {
      cleanup()
      cleanup = undefined
    }
    try {
      const maybeCleanup = fn()
      if (typeof maybeCleanup === 'function') {
        cleanup = maybeCleanup
      }
    } catch (err) {
      const handled = handleError(err, { source: 'effect' }, rootForError)
      if (handled) {
        return
      }
      throw err
    }
  }

  const disposeEffect = effect(run)
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
