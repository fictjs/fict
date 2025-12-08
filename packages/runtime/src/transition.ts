import { createEffect } from './effect'
import { setTransitionContext, signal, scheduleFlush, untrack } from './signal'

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
 * React-style useTransition hook.
 * Returns a pending signal and a startTransition function.
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
export function useTransition(): [() => boolean, (fn: () => void) => void] {
  const pending = signal(false)

  const start = (fn: () => void) => {
    pending(true)
    startTransition(() => {
      try {
        fn()
      } finally {
        pending(false)
      }
    })
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
