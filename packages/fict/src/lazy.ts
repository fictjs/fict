/**
 * @fileoverview Lazy component loading with Suspense support.
 *
 * The implementation lives in the runtime's first-party internal protocol so
 * framework and router lazy components share preload, reset, retry, and
 * Suspense semantics.
 */

import type { Component } from '@fictjs/runtime'
import { __fictCreateLazyComponent } from '@fictjs/runtime/internal'

/** Module shape produced by a typical dynamic import. */
export interface LazyModule<TProps extends Record<string, unknown>> {
  default: Component<TProps>
}

/** Options for lazy loading behavior. */
export interface LazyOptions {
  /** Maximum retry attempts after the initial load. Defaults to `0`. */
  maxRetries?: number
  /** Initial exponential-backoff delay in milliseconds. Defaults to `1000`. */
  retryDelay?: number
}

/** Component with explicit preload and retry-reset controls. */
export interface LazyComponent<TProps extends Record<string, unknown>> extends Component<TProps> {
  /** Clear a cached failure so the next render or preload starts a new load. */
  reset: () => void
  /** Load the component without rendering it. */
  preload: () => Promise<void>
}

/**
 * Create a lazy component that suspends while loading.
 *
 * The loader may resolve to a dynamic-import module or directly to a
 * component. Failed loads stay observable until `reset()` is called; optional
 * automatic retries use exponential backoff.
 *
 * @example
 * ```tsx
 * const LazyDashboard = lazy(() => import('./Dashboard'), {
 *   maxRetries: 2,
 *   retryDelay: 250,
 * })
 * ```
 *
 * @public
 */
export function lazy<TProps extends Record<string, unknown> = Record<string, unknown>>(
  loader: () => Promise<LazyModule<TProps> | Component<TProps>>,
  options: LazyOptions = {},
): LazyComponent<TProps> {
  return __fictCreateLazyComponent(loader, options)
}
