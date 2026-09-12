import {
  getCurrentRoot,
  handleError,
  handleSuspend,
  registerManagedEffectCleanup,
  runCleanupList,
  withEffectCleanups,
  type EffectCleanupScope,
} from './lifecycle'
import { effectWithCleanup, type EffectOptions } from './signal'
import type { Cleanup } from './types'

/**
 * Effect callback run synchronously; async callbacks are not tracked after the first await.
 * TypeScript will reject `async () => {}` here—split async work or read signals before awaiting.
 */
export type Effect = () => void | Cleanup

const noopCleanup = () => {}

function createManagedEffect(
  fn: Effect,
  options?: EffectOptions,
  releaseUnobserved = false,
): () => void {
  const cleanupScope: EffectCleanupScope = { cleanups: undefined }
  let phase: 'active' | 'disposing' | 'disposed' = 'active'
  const rootForError = getCurrentRoot()

  // Cleanup runner - called by runEffect BEFORE signal values are committed
  const doCleanup = () => {
    const pending = cleanupScope.cleanups
    cleanupScope.cleanups = undefined
    if (pending) runCleanupList(pending, rootForError)
  }

  const run = () => {
    if (phase !== 'active') return
    // Note: cleanups are now run by signal.ts runEffect before this function is called
    try {
      withEffectCleanups(cleanupScope, () => {
        try {
          const maybeCleanup = fn()
          if (typeof maybeCleanup === 'function') {
            ;(cleanupScope.cleanups ??= []).push(maybeCleanup)
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
      // A body can dispose itself and then register more cleanup before it
      // returns. Drain that late work without retaining a second run bucket.
      if (phase !== 'active') doCleanup()
    }
  }

  const finishTeardown = () => {
    if (phase !== 'active') return
    if (!cleanupScope.cleanups) {
      phase = 'disposed'
      return
    }
    phase = 'disposing'
    try {
      doCleanup()
    } finally {
      phase = 'disposed'
    }
  }

  const disposeEffect = effectWithCleanup(
    run,
    doCleanup,
    rootForError,
    options,
    finishTeardown,
    releaseUnobserved ? cleanupScope : undefined,
  )
  if (cleanupScope.released) return noopCleanup
  const teardown = () => {
    // An enclosing reactive scope may already have detached this effect and
    // drained its cleanup through onDispose before the root reaches this entry.
    if (phase === 'disposed') return
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
  return createManagedEffect(fn, options, true)
}
