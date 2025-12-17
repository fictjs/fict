// ============================================================================
// Core Reactive Primitives
// ============================================================================

export { createSignal, type Signal, $state } from './signal'
export { createMemo, type Memo, $memo } from './memo'
export { createEffect, type Effect, $effect } from './effect'
export {
  __fictUseContext,
  __fictUseSignal,
  __fictUseMemo,
  __fictUseEffect,
  __fictRender,
} from './hooks'
export {
  createVersionedSignal,
  type VersionedSignal,
  type VersionedSignalOptions,
} from './versioned-signal'

// ============================================================================
// Lifecycle
// ============================================================================

export { onMount, onDestroy, onCleanup, createRoot } from './lifecycle'

// Ref utilities
export { createRef } from './ref'

// ============================================================================
// Scheduler / Utilities
// ============================================================================

export { batch, untrack } from './scheduler'
export { setCycleProtectionOptions } from './cycle-guard'

// Transition API for priority scheduling
export { startTransition, useTransition, useDeferredValue } from './scheduler'

// ============================================================================
// JSX Runtime
// ============================================================================

export type { JSX } from './jsx'
export { Fragment } from './jsx'

// ============================================================================
// DOM Rendering
// ============================================================================

export { createElement, render, template } from './dom'
export { ErrorBoundary } from './error-boundary'
export { Suspense, createSuspenseToken } from './suspense'

// ============================================================================
// Reactive DOM Bindings
// ============================================================================

export {
  // Core binding utilities
  createTextBinding,
  createChildBinding,
  createAttributeBinding,
  createStyleBinding,
  createClassBinding,
  // Low-level binding helpers (for direct DOM manipulation)
  bindText,
  bindAttribute,
  bindStyle,
  bindClass,
  bindEvent,
  bindProperty,
  insert,
  // Event delegation
  delegateEvents,
  clearDelegatedEvents,
  addEventListener,
  // Spread props
  spread,
  assign,
  classList,
  // Reactive detection
  isReactive,
  // Advanced bindings
  createConditional,
  createList,
  createPortal,
  createShow,
  // Utility functions
  unwrap,
  unwrapPrimitive,
} from './binding'

// Constants for DOM handling
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

// Reconcile algorithm
export { default as reconcileArrays } from './reconcile'

// ============================================================================
// Types
// ============================================================================

export type {
  MaybeReactive,
  BindingHandle,
  KeyFn,
  CreateElementFn,
  AttributeSetter,
} from './binding'

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

// Devtools hook (optional)
export { getDevtoolsHook, type FictDevtoolsHook } from './devtools'

// ============================================================================
// List Helpers (for compiler-generated code)
// ============================================================================

export {
  // DOM manipulation primitives
  moveNodesBefore,
  removeNodes,
  insertNodesBefore,
  moveMarkerBlock,
  destroyMarkerBlock,
  // Keyed list container
  createKeyedListContainer,
  // Block creation
  createKeyedBlock,
  // High-level list binding (for compiler-generated code)
  createKeyedList,
  // Utilities
  toNodeArray,
  getFirstNodeAfter,
  isNodeBetweenMarkers,
  // Types
  type KeyedBlock,
  type KeyedListContainer,
  type KeyedListBinding,
  type MarkerBlock,
} from './list-helpers'
