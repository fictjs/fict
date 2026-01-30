/**
 * @fileoverview Internal APIs for Fict Compiler
 *
 * This module exports internal APIs used by compiler-generated code.
 * These APIs are NOT part of the public API and should NOT be used directly.
 *
 * @internal
 * @packageDocumentation
 */

// ============================================================================
// Core Primitives (also exported from main, but needed by compiler)
// ============================================================================

export { createSignal, createSelector, __resetReactiveState } from './signal'
export { createStore, type Store } from './store'
export { createMemo } from './memo'
export { createEffect } from './effect'
export { Fragment } from './jsx'

// ============================================================================
// Hook Context Management (Compiler-generated code)
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
// Props Helpers (Compiler-generated code)
// ============================================================================

export { __fictProp, __fictPropsRest, createPropsProxy, mergeProps, prop, keyed } from './props'

// ============================================================================
// DOM Bindings (Compiler-generated code)
// ============================================================================

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
  createConditional,
  createPortal,
  spread,
  assign,
  classList,
  isReactive,
  unwrap,
} from './binding'

// ============================================================================
// Event Delegation (Compiler-generated code)
// ============================================================================

export { delegateEvents, clearDelegatedEvents, addEventListener } from './binding'

// ============================================================================
// List Helpers (Compiler-generated code)
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

// ============================================================================
// DOM Creation (Compiler-generated code)
// ============================================================================

export { createElement, template } from './dom'
export { createRenderEffect } from './effect'

// ============================================================================
// Lifecycle (Compiler-generated code)
// ============================================================================

export { onDestroy } from './lifecycle'

// ============================================================================
// Scope (Compiler-generated code)
// ============================================================================

export { runInScope } from './scope'

// ============================================================================
// Constants (Compiler/Runtime shared)
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
// Reconciliation (Internal)
// ============================================================================

export { default as reconcileArrays } from './reconcile'

// ============================================================================
// Types (Internal)
// ============================================================================

export type { MaybeReactive, BindingHandle, CreateElementFn, AttributeSetter } from './binding'
