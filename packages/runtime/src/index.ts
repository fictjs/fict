/**
 * @fileoverview Fict Runtime - Public API
 *
 * This module exports the public API for the Fict reactive UI framework.
 *
 * ## Recommended Import Pattern (v1.0+)
 *
 * ```typescript
 * // Core public API (most users need only this)
 * import { createEffect, render } from '@fictjs/runtime'
 *
 * // Advanced APIs (power users, escape hatches)
 * import { createSignal, createContext, createScope } from '@fictjs/runtime/advanced'
 *
 * // Internal APIs (compiler/library authors only)
 * import { bindText, __fictUseSignal } from '@fictjs/runtime/internal'
 * ```
 *
 * @public
 * @packageDocumentation
 */

// ============================================================================
// Core Reactive Primitives
// ============================================================================

/**
 * Note: createSignal is exported from ./advanced as an escape hatch.
 * For most use cases, prefer:
 * - $state: For component-local state (compiler-transformed, safe scoping)
 * - $store: For cross-component shared state with deep reactivity
 */
export { createMemo, type Memo } from './memo'
export { createEffect, type Effect } from './effect'

// ============================================================================
// Lifecycle
// ============================================================================

export { onMount, onDestroy, onCleanup, createRoot } from './lifecycle'

// ============================================================================
// Ref
// ============================================================================

export { createRef } from './ref'

// ============================================================================
// Scheduler / Utilities
// ============================================================================

export { batch, untrack } from './scheduler'
export { startTransition, useTransition, useDeferredValue } from './scheduler'

// ============================================================================
// JSX Runtime
// ============================================================================

export type { JSX } from './jsx'
export { Fragment } from './jsx'

// ============================================================================
// DOM Rendering
// ============================================================================

export { createElement, render } from './dom'
export { createPortal } from './binding'
export { ErrorBoundary } from './error-boundary'
export { Suspense, createSuspenseToken } from './suspense'
export { createContext, useContext, hasContext, type Context, type ProviderProps } from './context'

// ============================================================================
// Props Utilities (Public)
// ============================================================================

export { prop, mergeProps } from './props'

// ============================================================================
// Types
// ============================================================================

export type {
  FictNode,
  FictVNode,
  DOMElement,
  Cleanup,
  Component,
  BaseProps,
  PropsWithChildren,
  Ref,
  RefCallback,
  RefObject,
  StyleProp,
  ClassProp,
  EventHandler,
  ErrorInfo,
  SuspenseToken,
} from './types'
