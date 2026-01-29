/**
 * @fileoverview Type definitions for @fictjs/testing-library
 *
 * This module provides TypeScript type definitions for the Fict testing library.
 *
 * @packageDocumentation
 */

import type { FictNode, Component } from '@fictjs/runtime'
import type { queries, BoundFunctions, Queries, prettyFormat } from '@testing-library/dom'

// ============================================================================
// Core Types
// ============================================================================

/**
 * Internal reference to a mounted container for cleanup tracking.
 */
export interface MountedRef {
  container?: HTMLElement
  baseElement?: HTMLElement
  ownedContainer?: boolean
  teardown: () => void
}

/**
 * A Fict view function that returns a FictNode.
 */
export type View = () => FictNode

// ============================================================================
// Render Options
// ============================================================================

/**
 * Options for the render function.
 */
export interface RenderOptions<Q extends Queries = typeof queries> {
  /**
   * The container element to render into. If not provided, a div will be created.
   */
  container?: HTMLElement

  /**
   * The base element for queries. Defaults to the container when provided,
   * otherwise defaults to document.body.
   */
  baseElement?: HTMLElement

  /**
   * Custom queries to use instead of the default queries.
   */
  queries?: Q

  /**
   * A wrapper component to wrap the rendered view with.
   * Useful for providing context or other providers.
   */
  wrapper?: Component<{ children: FictNode }>
}

// ============================================================================
// Render Result
// ============================================================================

/**
 * Debug function type for pretty-printing DOM.
 */
export type DebugFn = (
  baseElement?: HTMLElement | HTMLElement[],
  maxLength?: number,
  options?: prettyFormat.OptionsReceived,
) => void

/**
 * Result returned from render().
 */
export type RenderResult<Q extends Queries = typeof queries> = BoundFunctions<Q> & {
  /**
   * Returns the innerHTML of the container as a string.
   */
  asFragment: () => string

  /**
   * The container element the view was rendered into.
   */
  container: HTMLElement

  /**
   * The base element for queries.
   */
  baseElement: HTMLElement

  /**
   * Pretty-print the DOM for debugging.
   */
  debug: DebugFn

  /**
   * Unmount the rendered view and clean up.
   */
  unmount: () => void

  /**
   * Re-render with a new view.
   */
  rerender: (newView: View) => void
}

// ============================================================================
// RenderHook Types
// ============================================================================

/**
 * Options for renderHook function.
 */
export interface RenderHookOptions<Props extends unknown[]> {
  /**
   * Initial props to pass to the hook.
   */
  initialProps?: Props

  /**
   * A wrapper component to wrap the hook with.
   */
  wrapper?: Component<{ children: FictNode }>
}

/**
 * Result returned from renderHook().
 */
export interface RenderHookResult<Result, Props extends unknown[]> {
  /**
   * Container holding the result of calling the hook.
   * Access via `result.current`. Updated when the hook re-runs.
   */
  result: { current: Result }

  /**
   * Re-render the hook with new props.
   * Note: this disposes the previous root and mounts a new one; hook state resets.
   */
  rerender: (newProps?: Props) => void

  /**
   * Clean up the hook and dispose of the root.
   */
  cleanup: () => void

  /**
   * Alias for cleanup.
   */
  unmount: () => void
}

// ============================================================================
// TestEffect Types
// ============================================================================

/**
 * Callback function signature for testEffect.
 * @param done - Call this function with the result when the effect completes.
 */
export type TestEffectCallback<T> = (done: (result: T) => void) => void

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * Configuration options for the testing library.
 */
export interface ConfigOptions {
  /**
   * Whether to skip automatic cleanup after each test.
   * Defaults to false (cleanup runs automatically).
   */
  skipAutoCleanup?: boolean
}

// ============================================================================
// ErrorBoundary Testing Types
// ============================================================================

/**
 * Result returned from renderWithErrorBoundary().
 */
export type ErrorBoundaryRenderResult<Q extends Queries = typeof queries> = RenderResult<Q> & {
  /**
   * Trigger an error in the error boundary by rendering a component that throws.
   */
  triggerError: (error: Error) => void

  /**
   * Reset the error boundary to re-render children.
   */
  resetErrorBoundary: () => void

  /**
   * Check if the error boundary is currently showing the fallback.
   */
  isShowingFallback: () => boolean
}

/**
 * Options for renderWithErrorBoundary().
 */
export type ErrorBoundaryRenderOptions<Q extends Queries = typeof queries> = RenderOptions<Q> & {
  /**
   * The fallback UI to show when an error is caught.
   * Can be a FictNode or a function that receives the error and reset function.
   */
  fallback?: FictNode | ((err: unknown, reset?: () => void) => FictNode)

  /**
   * Callback called when an error is caught.
   */
  onError?: (err: unknown) => void

  /**
   * Keys that trigger a reset when changed.
   */
  resetKeys?: unknown | (() => unknown)
}

// ============================================================================
// Suspense Testing Types
// ============================================================================

/**
 * Result returned from renderWithSuspense().
 */
export type SuspenseRenderResult<Q extends Queries = typeof queries> = RenderResult<Q> & {
  /**
   * Check if the suspense boundary is currently showing the fallback.
   */
  isShowingFallback: () => boolean

  /**
   * Wait for the suspense to resolve.
   */
  waitForResolution: (options?: { timeout?: number }) => Promise<void>
}

/**
 * Options for renderWithSuspense().
 */
export type SuspenseRenderOptions<Q extends Queries = typeof queries> = RenderOptions<Q> & {
  /**
   * The fallback UI to show while suspended.
   */
  fallback?: FictNode | ((err?: unknown) => FictNode)

  /**
   * Callback called when the suspense resolves.
   */
  onResolve?: () => void

  /**
   * Callback called when the suspense rejects.
   *
   * Note: providing onReject treats the rejection as handled in the test root
   * to avoid unhandled promise rejections.
   */
  onReject?: (err: unknown) => void

  /**
   * Keys that trigger a reset when changed.
   */
  resetKeys?: unknown | (() => unknown)
}

/**
 * Handle returned from createTestSuspenseToken().
 */
export interface TestSuspenseHandle {
  /**
   * The suspense token to throw in a component.
   */
  token: { then: PromiseLike<void>['then'] }

  /**
   * Resolve the suspense, allowing children to render.
   */
  resolve: () => void

  /**
   * Reject the suspense with an error.
   */
  reject: (err: unknown) => void
}
