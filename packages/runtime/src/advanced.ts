/**
 * @fileoverview Advanced APIs for Fict
 *
 * This module exports advanced APIs for power users and library authors.
 * These APIs are stable but require deeper understanding of Fict internals.
 *
 * @advanced
 * @packageDocumentation
 */

// ============================================================================
// Reactive Scope Management
// ============================================================================

export { createScope, runInScope, type ReactiveScope } from './scope'
export { effectScope } from './signal'

// ============================================================================
// Fine-grained Subscription
// ============================================================================

export { createSelector } from './signal'

// ============================================================================
// Versioned Signal
// ============================================================================

export {
  createVersionedSignal,
  type VersionedSignal,
  type VersionedSignalOptions,
} from './versioned-signal'

// ============================================================================
// High-Level Binding Factories
// ============================================================================

export {
  createTextBinding,
  createChildBinding,
  createAttributeBinding,
  createStyleBinding,
  createClassBinding,
  createShow,
} from './binding'

// ============================================================================
// Utilities
// ============================================================================

export { isReactive, unwrap } from './binding'

// ============================================================================
// Debugging & DevTools
// ============================================================================

export { getDevtoolsHook, type FictDevtoolsHook } from './devtools'
export { setCycleProtectionOptions } from './cycle-guard'

// ============================================================================
// Low-level Primitives (for library authors)
// ============================================================================

export { createRenderEffect } from './effect'

// ============================================================================
// DOM Constants (for library authors building custom renderers)
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
