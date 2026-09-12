import {
  getCurrentRoot,
  handleError,
  handleSuspend,
  registerManagedEffectCleanup,
  runCleanupList,
  withEffectCleanups,
} from './lifecycle'
import { effectWithCleanup, type EffectOptions } from './signal'
import type { Cleanup } from './types'

/**
 * Effect callback run synchronously; async callbacks are not tracked after the first await.
 * TypeScript will reject `async () => {}` here—split async work or read signals before awaiting.
 */
export type Effect = () => void | Cleanup

function createManagedEffect(fn: Effect, options?: EffectOptions): () => void {
  let cleanups: Cleanup[] = []
  let inFlightCleanups: Cleanup[] | undefined
  let phase: 'active' | 'disposing' | 'disposed' = 'active'
  const rootForError = getCurrentRoot()

  const takeCleanups = () => {
    const pending = cleanups
    cleanups = []
    return pending
  }

  // Cleanup runner - called by runEffect BEFORE signal values are committed
  const doCleanup = () => {
    runCleanupList(takeCleanups(), rootForError)
  }

  const run = () => {
    if (phase !== 'active') return
    // Note: cleanups are now run by signal.ts runEffect before this function is called
    const bucket: Cleanup[] = []
    inFlightCleanups = bucket
    try {
      withEffectCleanups(bucket, () => {
        try {
          const maybeCleanup = fn()
          if (typeof maybeCleanup === 'function') {
            bucket.push(maybeCleanup)
          }
        } catch (err) {
          if (handleSuspend(err as Parameters<typeof handleSuspend>[0], rootForError)) {
            return
          }
          if (handleError(err, { source: 'effect' }, rootForError)) {
            return
          }
          throw err
        }
      })
    } finally {
      if (inFlightCleanups === bucket) {
        inFlightCleanups = undefined
      }
      if (phase === 'active') {
        cleanups = bucket
      } else if (bucket.length > 0) {
        runCleanupList(bucket, rootForError)
      }
    }
  }

  const finishTeardown = () => {
    if (phase !== 'active') return
    phase = 'disposing'
    const inFlight = inFlightCleanups
    inFlightCleanups = undefined
    try {
      try {
        runCleanupList(takeCleanups(), rootForError)
      } finally {
        if (inFlight) {
          runCleanupList(inFlight, rootForError)
        }
      }
    } finally {
      phase = 'disposed'
    }
  }

  const disposeEffect = effectWithCleanup(run, doCleanup, rootForError, options, finishTeardown)
  const teardown = () => {
    try {
      finishTeardown()
    } finally {
      // A cleanup failure must still detach the complete reactive subtree.
      disposeEffect()
    }
  }

  registerManagedEffectCleanup(teardown)

  return teardown
}

export function createEffect(fn: Effect, options?: EffectOptions): () => void {
  return createManagedEffect(fn, options)
}

export function createRenderEffect(fn: Effect, options?: EffectOptions): () => void {
  return createManagedEffect(fn, options)
}
