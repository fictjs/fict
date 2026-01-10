/**
 * @fileoverview Fict Runtime Public API
 *
 * This module exports all public APIs for the Fict reactive UI framework.
 *
 * API Stability Tiers:
 * - @public (Tier 1): Frozen public API, guaranteed stable across v1.x
 * - @internal (Tier 2): Compiler-dependent helpers, signature-stable
 * - @advanced (Tier 3): Advanced use cases, best-effort stability
 * - @experimental (Tier 4): May change without notice
 *
 * @packageDocumentation
 */

// ============================================================================
// Core Reactive Primitives
// ============================================================================

/**
 * @public Core reactive primitives - Tier 1 frozen API
 */
export { createSignal, createSelector, type Signal, $state } from './signal'
export { effectScope } from './signal'
export { createStore, type Store } from './store'
export { createMemo, type Memo, $memo } from './memo'
export { createEffect, createRenderEffect, type Effect, $effect } from './effect'
export { createScope, runInScope, type ReactiveScope } from './scope'

/**
 * @internal Compiler hook helpers - Tier 2, signature-stable
 * These are used by compiler-generated code and must maintain
 * backward compatibility for compiled user code.
 */
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

/** @public Versioned signal - Tier 1 frozen API */
export {
  createVersionedSignal,
  type VersionedSignal,
  type VersionedSignalOptions,
} from './versioned-signal'

/**
 * @internal Props helpers - Tier 2, compiler-dependent
 * __fictProp and __fictPropsRest are used by compiler for reactive prop access
 */
export {
  __fictProp,
  __fictProp as prop,
  __fictPropsRest,
  mergeProps,
  useProp,
  createPropsProxy,
} from './props'

// ============================================================================
// Lifecycle
// ============================================================================

/** @public Lifecycle hooks - Tier 1 frozen API */
export { onMount, onDestroy, onCleanup, createRoot } from './lifecycle'

/** @public Ref utilities - Tier 1 frozen API */
export { createRef } from './ref'

// ============================================================================
// Scheduler / Utilities
// ============================================================================

/** @public Scheduler utilities - Tier 1 frozen API */
export { batch, untrack } from './scheduler'

/** @advanced Cycle protection configuration - Tier 3 */
export { setCycleProtectionOptions } from './cycle-guard'

/** @public Transition API for priority scheduling - Tier 1 frozen API */
export { startTransition, useTransition, useDeferredValue } from './scheduler'

// ============================================================================
// JSX Runtime
// ============================================================================

/** @public JSX types and Fragment - Tier 1 frozen API */
export type { JSX } from './jsx'
export { Fragment } from './jsx'

// ============================================================================
// DOM Rendering
// ============================================================================

/** @public DOM rendering - Tier 1 frozen API */
export { createElement, render, template } from './dom'
export { ErrorBoundary } from './error-boundary'
export { Suspense, createSuspenseToken } from './suspense'

// ============================================================================
// Reactive DOM Bindings
// ============================================================================

/**
 * @advanced High-level binding factories - Tier 3
 * These return BindingHandle for manual lifecycle control
 */
export {
  createTextBinding,
  createChildBinding,
  createAttributeBinding,
  createStyleBinding,
  createClassBinding,
} from './binding'

/**
 * @internal Low-level binding helpers - Tier 2, compiler-dependent
 * Used by compiler-generated code for DOM updates
 */
export {
  bindText,
  bindAttribute,
  bindStyle,
  bindClass,
  bindEvent,
  callEventHandler,
  bindProperty,
  bindRef,
  insert,
} from './binding'

/**
 * @internal Event delegation - Tier 2, compiler-dependent
 * delegateEvents is called at module initialization by compiler
 */
export { delegateEvents, clearDelegatedEvents, addEventListener } from './binding'

/**
 * @internal Spread and assign - Tier 2
 */
export { spread, assign, classList } from './binding'

/**
 * @advanced Utility functions - Tier 3
 */
export { isReactive, unwrap } from './binding'

/**
 * @internal Advanced bindings - Tier 2, compiler-dependent
 * createConditional is used by compiler for control flow
 */
export { createConditional, createPortal, createShow } from './binding'

/**
 * @advanced DOM constants - Tier 3
 * Reference data for DOM handling, may be useful for advanced integrations
 */
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

/** @advanced Reconcile algorithm - Tier 3 */
export { default as reconcileArrays } from './reconcile'

// ============================================================================
// Types
// ============================================================================

/**
 * @public Type definitions - Tier 1 frozen API
 * These types are part of the public API contract
 */
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

/**
 * @advanced Devtools hook - Tier 3
 * For browser extension and debugging integration
 */
export { getDevtoolsHook, type FictDevtoolsHook } from './devtools'

// ============================================================================
// List Helpers (for compiler-generated code)
// ============================================================================

/**
 * @internal List helpers - Tier 2, compiler-dependent
 * createKeyedList and toNodeArray are used by compiler for array rendering
 */
export {
  moveNodesBefore,
  removeNodes,
  insertNodesBefore,
  createKeyedList,
  toNodeArray,
  isNodeBetweenMarkers,
  type KeyedListBinding,
} from './list-helpers'
