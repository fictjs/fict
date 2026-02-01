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
export { createStore, type Store, isStoreProxy, unwrapStore } from './store'
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
  __fictPrepareContext,
} from './hooks'

// ============================================================================
// SSR / Resumability (Internal)
// ============================================================================

export {
  __fictEnableSSR,
  __fictDisableSSR,
  __fictEnableResumable,
  __fictDisableResumable,
  __fictIsResumable,
  __fictEnterHydration,
  __fictExitHydration,
  __fictIsHydrating,
  __fictRegisterScope,
  __fictGetScopeRegistry,
  __fictSerializeSSRState,
  __fictSetSSRState,
  __fictGetSSRScope,
  __fictEnsureScope,
  __fictUseLexicalScope,
  __fictGetScopeProps,
  __fictQrl,
} from './resume'

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
  insertBetween,
  createConditional,
  createPortal,
  spread,
  assign,
  classList,
  isReactive,
  unwrap,
} from './binding'
export { resolvePath, getSlotEnd } from './node-ops'

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

export { createElement, template, render, hydrateComponent } from './dom'
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
