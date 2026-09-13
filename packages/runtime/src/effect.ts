import { isAsyncPending } from './async-state'
import {
  getCurrentRoot,
  handleError,
  handleSuspend,
  registerManagedEffectCleanup,
  runCleanupList,
  withEffectCleanups,
  type EffectCleanupScope,
  type RootContext,
} from './lifecycle'
import { effectWithCleanup, isAsyncRejection, type EffectOptions } from './signal'
import type { Cleanup } from './types'

/**
 * Effect callback run synchronously; async callbacks are not tracked after the first await.
 * TypeScript will reject `async () => {}` here—split async work or read signals before awaiting.
 */
export type Effect = () => void | Cleanup

const noopCleanup = () => {}

function handleEffectFailure(err: unknown, root: RootContext | undefined): void {
  if (isAsyncRejection(err)) {
    if (handleError(err, { source: 'effect' }, root)) return
    throw err
  }
  if (isAsyncPending(err)) {
    handleSuspend(err, root)
    return
  }
  if (handleSuspend(err as Parameters<typeof handleSuspend>[0], root)) return
  if (handleError(err, { source: 'effect' }, root)) return
  throw err
}

function createManagedEffect<T = void>(
  fn: Effect,
  options?: EffectOptions,
  releaseUnobserved = false,
  prepare?: () => T,
  commit?: (value: T) => void | Cleanup,
): () => void {
  const cleanupScope: EffectCleanupScope = { cleanups: undefined }
  let phase: 'active' | 'disposing' | 'disposed' = 'active'
  const rootForError = getCurrentRoot()
  let preparedValue: T

  // Cleanup runner - called by runEffect BEFORE signal values are committed
  const doCleanup = () => {
    const pending = cleanupScope.cleanups
    cleanupScope.cleanups = undefined
    if (pending) runCleanupList(pending, rootForError)
  }

  const prepareRun = prepare
    ? () => {
        if (phase !== 'active') return false
        try {
          preparedValue = prepare()
          return true
        } catch (error) {
          handleEffectFailure(error, rootForError)
          return false
        }
      }
    : undefined

  const run = () => {
    if (phase !== 'active') return
    // Note: cleanups are now run by signal.ts runEffect before this function is called
    try {
      withEffectCleanups(cleanupScope, () => {
        try {
          const maybeCleanup = commit ? commit(preparedValue) : fn()
          if (typeof maybeCleanup === 'function') {
            ;(cleanupScope.cleanups ??= []).push(maybeCleanup)
          }
        } catch (err) {
          handleEffectFailure(err, rootForError)
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
    prepareRun,
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

/** Internal one-node binding: track the value before replacing committed work. */
export function createRenderBinding<T>(
  prepare: () => T,
  commit: (value: T) => void | Cleanup,
  options?: EffectOptions,
): () => void {
  // Keep preparation and commit in the managed owner without allocating a
  // separate value cell and two forwarding closures for every DOM binding.
  return createManagedEffect(noopCleanup, options, true, prepare, commit)
}

/** Internal views which prepare their own roots/DOM before committing them. */
export function createRenderTransaction(fn: Effect): () => void {
  return createManagedEffect(fn, undefined, true, noopCleanup)
}
