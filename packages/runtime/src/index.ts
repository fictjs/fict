/**
 * @fileoverview Fict Runtime - Complete API
 *
 * This module exports the complete API for the Fict reactive UI framework.
 *
 * ## Recommended Import Pattern (v1.0+)
 *
 * For new projects, we recommend using layered imports:
 *
 * ```typescript
 * // Core public API (most users need only this)
 * import { createSignal, createEffect, render } from '@fictjs/runtime'
 *
 * // Advanced APIs (power users)
 * import { createScope, createSelector } from '@fictjs/runtime/advanced'
 *
 * // Internal APIs (compiler/library authors only)
 * import { __fictProp, bindText } from '@fictjs/runtime/internal'
 * ```
 *
 * ## API Categories
 *
 * - **Public API (Tier 1)**: Core primitives, lifecycle, rendering
 * - **Advanced API (Tier 3)**: Scopes, selectors, bindings, devtools
 * - **Internal API (Tier 2)**: Compiler helpers, low-level bindings
 *
 * @packageDocumentation
 */

// ============================================================================
// Core Reactive Primitives (Public API - Tier 1)
// ============================================================================

export { createSignal, createSelector, type Signal } from './signal'
export { effectScope } from './signal'
export { createStore, type Store } from './store'
export { createMemo, type Memo } from './memo'
export { createEffect, createRenderEffect, type Effect } from './effect'
export { createScope, runInScope, type ReactiveScope } from './scope'
export {
  createVersionedSignal,
  type VersionedSignal,
  type VersionedSignalOptions,
} from './versioned-signal'

// ============================================================================
// Internal Hook Helpers (Internal API - Tier 2)
// Used by compiler-generated code
// ============================================================================

export {
  __fictUseContext,
  __fictPushContext,
  __fictPopContext,
  __fictUseSignal,
  __fictUseMemo,
  __fictUseEffect,
  __fictRender,
  __fictResetContext,
} from './hooks'

// ============================================================================
// Props Helpers
// ============================================================================

export {
  __fictProp,
  __fictProp as prop,
  __fictPropsRest,
  mergeProps,
  useProp,
  createPropsProxy,
} from './props'

// ============================================================================
// Lifecycle (Public API - Tier 1)
// ============================================================================

export { onMount, onDestroy, onCleanup, createRoot } from './lifecycle'

// ============================================================================
// Ref (Public API - Tier 1)
// ============================================================================

export { createRef } from './ref'

// ============================================================================
// Scheduler / Utilities (Public API - Tier 1)
// ============================================================================

export { batch, untrack } from './scheduler'
export { setCycleProtectionOptions } from './cycle-guard'
export { startTransition, useTransition, useDeferredValue } from './scheduler'

// ============================================================================
// JSX Runtime (Public API - Tier 1)
// ============================================================================

export type { JSX } from './jsx'
export { Fragment } from './jsx'

// ============================================================================
// DOM Rendering (Public API - Tier 1)
// ============================================================================

export { createElement, render, template } from './dom'
export { ErrorBoundary } from './error-boundary'
export { Suspense, createSuspenseToken } from './suspense'

// ============================================================================
// Reactive DOM Bindings (Internal/Advanced API)
// ============================================================================

export {
  // High-level binding factories (Advanced API - Tier 3)
  createTextBinding,
  createChildBinding,
  createAttributeBinding,
  createStyleBinding,
  createClassBinding,
  // Low-level binding helpers (Internal API - Tier 2)
  bindText,
  bindAttribute,
  bindStyle,
  bindClass,
  bindEvent,
  callEventHandler,
  bindProperty,
  bindRef,
  insert,
  // Event delegation (Internal API - Tier 2)
  delegateEvents,
  clearDelegatedEvents,
  addEventListener,
  // Spread props (Internal API - Tier 2)
  spread,
  assign,
  classList,
  // Utilities (Advanced API - Tier 3)
  isReactive,
  // Advanced bindings (Internal API - Tier 2)
  createConditional,
  createPortal,
  createShow,
  unwrap,
} from './binding'

// ============================================================================
// Constants (Advanced API - Tier 3)
// ============================================================================

export {
  Properties,
  ChildProperties,
  Aliases,
  getPropAlias,
  BooleanAttributes,
  SVGElements,
  SVGNamespace,
  DelegatedEvents,
  UnitlessStyles,
} from './constants'

// ============================================================================
// Reconciliation (Internal API)
// ============================================================================

export { default as reconcileArrays } from './reconcile'

// ============================================================================
// Types (Public API - Tier 1)
// ============================================================================

export type { MaybeReactive, BindingHandle, CreateElementFn, AttributeSetter } from './binding'

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

// ============================================================================
// Devtools (Advanced API - Tier 3)
// ============================================================================

export { getDevtoolsHook, type FictDevtoolsHook } from './devtools'

// ============================================================================
// List Helpers (Internal API - Tier 2)
// ============================================================================

export {
  moveNodesBefore,
  removeNodes,
  insertNodesBefore,
  createKeyedList,
  toNodeArray,
  isNodeBetweenMarkers,
  type KeyedListBinding,
} from './list-helpers'
