import { createEffect } from './effect'
import { getCurrentRoot, registerRootCleanup, withRootContext } from './lifecycle'
import { setTransitionContext, signal, scheduleFlush, untrack } from './signal'
import {
  captureTransitionContext,
  TransitionScope,
  withTransitionContext,
} from './transition-scope'

// ============================================================================
// startTransition - Mark updates as low priority
// ============================================================================

/**
 * Execute a function with low-priority scheduling.
 * Updates triggered inside the callback will be processed after any high-priority updates.
 * This keeps the UI responsive during expensive operations.
 *
 * @param fn - The function to execute in transition context
 *
 * @example
 * ```tsx
 * const handleInput = (e) => {
 *   query = e.target.value  // High priority: immediate
 *   startTransition(() => {
 *     // Low priority: processed after high priority updates
 *     filteredItems = allItems.filter(x => x.includes(query))
 *   })
 * }
 * ```
 */
export function startTransition(fn: () => void): void {
  const prev = setTransitionContext(true)
  try {
    fn()
  } finally {
    setTransitionContext(prev)
    scheduleFlush()
  }
}

// ============================================================================
// useTransition - Hook for managing transition state
// ============================================================================

/**
 * Returns transition readiness and a function for starting low-priority updates.
 * Pending includes registered downstream async graph work and a returned Promise.
 * Native await/timer continuations do not implicitly inherit the callback context.
 *
 * @returns A tuple of [isPending accessor, startTransition function]
 *
 * @example
 * ```tsx
 * function SearchComponent() {
 *   let query = $state('')
 *   const [isPending, start] = useTransition()
 *
 *   const handleChange = (e) => {
 *     query = e.target.value
 *     start(() => {
 *       // Expensive filtering happens in low priority
 *       filteredResults = expensiveFilter(allData, query)
 *     })
 *   }
 *
 *   return (
 *     <>
 *       <input value={query} onInput={handleChange} />
 *       {isPending() && <Spinner />}
 *       <Results items={filteredResults} />
 *     </>
 *   )
 * }
 * ```
 */
export function useTransition(): [() => boolean, (fn: () => void | PromiseLike<unknown>) => void] {
  const pending = signal(false)
  const owner = getCurrentRoot()
  const scopes = new Set<TransitionScope>()
  let disposed = false
  let pendingCount = 0

  registerRootCleanup(() => {
    disposed = true
    for (const scope of scopes) scope.cancel()
    scopes.clear()
  })

  const beginPending = () => {
    pendingCount += 1
    if (pendingCount === 1) {
      pending(true)
    }
  }

  const endPending = () => {
    if (pendingCount === 0) return
    pendingCount -= 1
    if (pendingCount === 0) {
      pending(false)
    }
  }

  const start = (fn: () => void | PromiseLike<unknown>) => {
    if (disposed) return
    beginPending()
    const scope = new TransitionScope(() => {
      scopes.delete(scope)
      endPending()
    })
    scopes.add(scope)
    const context = new Set(captureTransitionContext())
    context.add(scope)
    let result: void | PromiseLike<unknown> | undefined
    let thrown: unknown
    let didThrow = false

    withTransitionContext(context, () =>
      startTransition(() => {
        try {
          result = withRootContext(owner ?? getCurrentRoot(), fn)
        } catch (err) {
          thrown = err
          didThrow = true
        }
      }),
    )

    if (didThrow) {
      scope.cancel()
      throw thrown
    }

    let isThenable: boolean
    try {
      isThenable = Boolean(result && typeof (result as PromiseLike<unknown>).then === 'function')
    } catch (error) {
      scope.cancel()
      throw error
    }

    if (isThenable) {
      try {
        void Promise.resolve(result)
          .catch(error => {
            if (typeof console !== 'undefined' && typeof console.error === 'function') {
              console.error('[fict/transition] Async transition failed.', error)
            }
          })
          .finally(() => {
            scope.close()
          })
      } catch (error) {
        scope.cancel()
        throw error
      }
      return
    }

    // Keep pending true for at least one microtask so UI can observe it.
    if (typeof queueMicrotask === 'function') {
      queueMicrotask(() => scope.close())
    } else {
      Promise.resolve().then(() => scope.close())
    }
  }

  return [() => pending(), start]
}

// ============================================================================
// useDeferredValue - Defer value updates to low priority
// ============================================================================

/**
 * Creates a deferred version of a value that updates with low priority.
 * The returned accessor will lag behind the source value during rapid updates,
 * allowing high-priority work to complete first.
 *
 * @param getValue - Accessor function that returns the source value
 * @returns Accessor function that returns the deferred value
 *
 * @example
 * ```tsx
 * function SearchResults({ query }) {
 *   const deferredQuery = useDeferredValue(() => query)
 *
 *   // deferredQuery lags behind query during rapid typing
 *   const results = expensiveSearch(deferredQuery())
 *
 *   return <ResultList items={results} />
 * }
 * ```
 */
export function useDeferredValue<T>(getValue: () => T): () => T {
  const deferredValue = signal(getValue())

  // Track source value changes and update deferred value in transition
  createEffect(() => {
    const newValue = getValue()
    // Use untrack to read current deferred value without creating a dependency
    // This prevents the effect from re-running when deferredValue changes
    const currentDeferred = untrack(() => deferredValue())
    if (currentDeferred !== newValue) {
      startTransition(() => {
        deferredValue(newValue)
      })
    }
  })

  return () => deferredValue()
}
