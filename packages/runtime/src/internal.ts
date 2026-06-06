/**
 * @fileoverview Compiler ABI for Fict-generated code
 *
 * This subpath is exported so compiler-generated code and first-party packages
 * can share runtime helpers. It is not a user-facing public API:
 *
 * - signatures are kept compatible for supported compiler output;
 * - implementations may change in minor/patch releases;
 * - application and library code should not import this subpath directly.
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
  __fictIsSSR,
  __fictEnableResumable,
  __fictDisableResumable,
  __fictIsResumable,
  __fictEnterHydration,
  __fictExitHydration,
  __fictIsHydrating,
  __fictRegisterScope,
  __fictGetScopeRegistry,
  __fictGetScopesForBoundary,
  __fictSerializeSSRState,
  __fictSerializeSSRStateForScopes,
  __fictSetSSRState,
  __fictMergeSSRState,
  __fictGetSSRScope,
  __fictEnsureScope,
  __fictUseLexicalScope,
  __fictGetScopeProps,
  __fictSetComponentMeta,
  __fictGetComponentMeta,
  __fictQrl,
  __fictRegisterResume,
  __fictGetResume,
  FICT_SSR_SNAPSHOT_SCHEMA_VERSION,
  serializeValue,
  deserializeValue,
} from './resume'
export {
  __fictCreateSSRSession,
  __fictRunWithSSRSession,
  __fictGetCurrentSSRSession,
} from './ssr-session'
export { __fictGetSSRStreamHooks, __fictSetSSRStreamHooks } from './ssr-stream'

// ============================================================================
// Props Helpers (Compiler-generated code)
// ============================================================================

export {
  __fictObjectRest,
  __fictProp,
  __fictPropsRest,
  createPropsProxy,
  mergeProps,
  prop,
  keyed,
} from './props'

// ============================================================================
// DOM Bindings (Compiler-generated code)
// ============================================================================

export {
  bindText,
  bindTextContent,
  bindAttribute,
  bindStyle,
  bindClass,
  setText,
  setTextContent,
  setAttr,
  setProp,
  setStyle,
  setClass,
  bindEvent,
  callEventHandler,
  bindProperty,
  bindRef,
  __fictReactive,
  nonReactive,
  reactive,
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
export type { HydrateComponentOptions } from './dom'
export type { HydrationIssue, HydrationIssueCode, HydrationIssueHandler } from './hydration'
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
