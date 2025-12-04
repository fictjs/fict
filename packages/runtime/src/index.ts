// ============================================================================
// Core Reactive Primitives
// ============================================================================

export { createSignal, type Signal, $state } from './signal'
export { createMemo, type Memo } from './memo'
export { createEffect, type Effect, $effect } from './effect'

// ============================================================================
// Lifecycle
// ============================================================================

export { onMount, onDestroy, onCleanup, createRoot } from './lifecycle'

// ============================================================================
// Scheduler / Utilities
// ============================================================================

export { batch, untrack } from './scheduler'

// ============================================================================
// JSX Runtime
// ============================================================================

export type { JSX } from './jsx'
export { Fragment } from './jsx'

// ============================================================================
// DOM Rendering
// ============================================================================

export { createElement, render } from './dom'

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
  bindProperty,
  insert,
  // Reactive detection
  isReactive,
  // Advanced bindings
  createConditional,
  createList,
  createPortal,
  createShow,
  // Utility functions
  unwrap,
} from './binding'

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
} from './list-helpers'
