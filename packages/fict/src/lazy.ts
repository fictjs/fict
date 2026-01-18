/**
 * @fileoverview Lazy component loading with Suspense support.
 *
 * Creates a component that loads its implementation asynchronously,
 * suspending rendering until the module is loaded.
 */

import { createSuspenseToken } from '@fictjs/runtime'
import type { Component } from '@fictjs/runtime'

/** Module shape expected from dynamic imports */
export interface LazyModule<TProps extends Record<string, unknown>> {
  default: Component<TProps>
}

/** Options for lazy loading behavior */
export interface LazyOptions {
  /**
   * Maximum number of retry attempts on load failure.
   * Set to 0 to disable retries (default behavior).
   * @default 0
   */
  maxRetries?: number

  /**
   * Delay in milliseconds between retry attempts.
   * Uses exponential backoff: delay * 2^(attempt - 1)
   * @default 1000
   */
  retryDelay?: number
}

/** Extended component with retry capability */
export interface LazyComponent<TProps extends Record<string, unknown>> extends Component<TProps> {
  /**
   * Reset the lazy component state, allowing it to retry loading.
   * Useful when used with ErrorBoundary reset functionality.
   */
  reset: () => void

  /**
   * Preload the component without rendering it.
   * Returns a promise that resolves when the component is loaded.
   */
  preload: () => Promise<void>
}

/**
 * Create a lazy component that suspends while loading.
 *
 * @param loader - Function that returns a promise resolving to the component module
 * @param options - Optional configuration for retry behavior
 * @returns A component that suspends during loading and supports retry on failure
 *
 * @example
 * ```tsx
 * import { lazy, Suspense } from 'fict'
 *
 * // Basic usage
 * const LazyChart = lazy(() => import('./Chart'))
 *
 * // With retry options
 * const LazyDashboard = lazy(() => import('./Dashboard'), {
 *   maxRetries: 3,
 *   retryDelay: 1000
 * })
 *
 * function App() {
 *   return (
 *     <Suspense fallback={<Loading />}>
 *       <LazyChart />
 *     </Suspense>
 *   )
 * }
 *
 * // Reset on error (with ErrorBoundary)
 * <ErrorBoundary fallback={(err, reset) => (
 *   <button onClick={() => { LazyChart.reset(); reset(); }}>Retry</button>
 * )}>
 *   <LazyChart />
 * </ErrorBoundary>
 * ```
 *
 * @public
 */
export function lazy<TProps extends Record<string, unknown> = Record<string, unknown>>(
  loader: () => Promise<LazyModule<TProps> | { default: Component<TProps> }>,
  options: LazyOptions = {},
): LazyComponent<TProps> {
  const { maxRetries = 0, retryDelay = 1000 } = options

  let loaded: Component<TProps> | null = null
  let loadError: unknown = null
  let loadingPromise: Promise<unknown> | null = null
  let pendingToken: ReturnType<typeof createSuspenseToken> | null = null
  let retryCount = 0

  const attemptLoad = (): Promise<void> => {
    return loader()
      .then(mod => {
        loaded = (mod as LazyModule<TProps>).default
        loadError = null
        retryCount = 0
        pendingToken?.resolve()
      })
      .catch((err: unknown) => {
        if (retryCount < maxRetries) {
          retryCount++
          const delay = retryDelay * Math.pow(2, retryCount - 1)
          return new Promise<void>(resolve => {
            setTimeout(() => {
              resolve(attemptLoad())
            }, delay)
          })
        }
        loadError = err
        pendingToken?.reject(err)
        return undefined
      })
      .finally(() => {
        loadingPromise = null
        pendingToken = null
      })
  }

  const component = ((props: TProps) => {
    if (loaded) {
      return loaded(props)
    }
    if (loadError) {
      throw loadError
    }
    if (!loadingPromise) {
      pendingToken = createSuspenseToken()
      loadingPromise = attemptLoad()
    }
    if (pendingToken) {
      throw pendingToken.token
    }
    // Should never hit if pendingToken exists, but fallback for type safety.
    throw new Error('Lazy component failed to start loading')
  }) as LazyComponent<TProps>

  /**
   * Reset the lazy component state, clearing any cached error.
   * Call this before triggering a re-render to retry loading.
   */
  component.reset = () => {
    loadError = null
    loadingPromise = null
    pendingToken = null
    retryCount = 0
    // Note: we don't clear `loaded` - if it was successfully loaded, keep it
  }

  /**
   * Preload the component without rendering.
   * Useful for eager loading on route prefetch.
   */
  component.preload = (): Promise<void> => {
    if (loaded) {
      return Promise.resolve()
    }
    if (loadingPromise) {
      return loadingPromise as Promise<void>
    }
    pendingToken = createSuspenseToken()
    loadingPromise = attemptLoad()
    return loadingPromise as Promise<void>
  }

  return component
}
