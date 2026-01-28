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
