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
// Context API (for subtree scoping / SSR isolation / multi-instance)
// ============================================================================

export { createContext, useContext, hasContext, type Context, type ProviderProps } from './context'

// ============================================================================
// Low-level Primitives (for library authors)
// ============================================================================

export { createRenderEffect } from './effect'

// ============================================================================
// Cross-component Signal (escape hatch for scalar/lightweight values)
// ============================================================================

/**
 * createSignal is an advanced/escape-hatch API for cross-component sharing
 * of scalar or lightweight values. For most use cases, prefer:
 *
 * - $state: For component-local state (compiler-transformed, safe scoping)
 * - $store: For cross-component shared state with deep reactivity
 *
 * Use createSignal when you need:
 * - A simple scalar value shared across components
 * - Library-level primitives
 * - Fine-grained control over reactivity
 *
 * @example
 * ```tsx
 * // In a shared module
 * export const globalCount = createSignal(0)
 *
 * // In any component
 * function Counter() {
 *   return <button onClick={() => globalCount(globalCount() + 1)}>
 *     Count: {globalCount()}
 *   </button>
 * }
 * ```
 */
export { createSignal, type Signal } from './signal'
