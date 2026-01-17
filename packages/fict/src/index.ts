/**
 * @fileoverview Fict Framework - Complete API
 *
 * This is the main entry point for the Fict framework.
 *
 * ## Recommended Import Pattern (v1.0+)
 *
 * ```typescript
 * // Core public API (most users need only this)
 * // Use $state in components (compiler-transformed)
 * // Use $store for cross-component shared state
 * import { $store, render } from 'fict'
 *
 * // Async utilities
 * import { resource, lazy } from 'fict/plus'
 *
 * // Advanced APIs (escape hatches, library authors)
 * import { createSignal, createContext, createScope } from 'fict/advanced'
 * ```
 *
 * ## State Management Guide
 *
 * | Use Case | API |
 * |----------|-----|
 * | Component-local state | `$state` (compiler-transformed) |
 * | Derived values / side effects | JS + auto-derived + `$effect` |
 * | Cross-component (large objects, deep mutation) | `$store` |
 * | Cross-component (scalar/lightweight, library-level) | `createSignal` (advanced) |
 * | Cross-component (subtree scope, SSR isolation) | `Context` (advanced) |
 *
 * @public
 * @packageDocumentation
 */

// Re-export everything from runtime
export * from '@fictjs/runtime'

// Re-export commonly used advanced APIs for convenience
export { createSelector, createScope, runInScope } from '@fictjs/runtime/advanced'

// ============================================================================
// Convenience Aliases
// ============================================================================

/**
 * Alias for createMemo.
 * Creates a memoized value that only recomputes when dependencies change.
 *
 * @example
 * ```tsx
 * const fullName = $memo(() => firstName + ' ' + lastName)
 * ```
 *
 * @public
 */
export { createMemo as $memo } from '@fictjs/runtime'

// ============================================================================
// Deep Reactive Store (Proxy-based)
// ============================================================================

/**
 * Create a deep reactive store using Proxy.
 * Unlike createStore, $store allows direct mutation.
 *
 * @example
 * ```tsx
 * const user = $store({ name: 'Alice', address: { city: 'Beijing' } })
 * user.name = 'Bob'  // Reactive update
 * user.address.city = 'Shanghai'  // Deep reactive
 * ```
 *
 * @public
 */
export { $store } from './store'

// ============================================================================
// Compiler Macros (transformed at compile time)
// ============================================================================

/**
 * Compiler macro for reactive state.
 * This is transformed at compile time and should never be called at runtime.
 *
 * @example
 * ```tsx
 * let count = $state(0)
 * count++ // Reactive update
 * ```
 *
 * @public
 */
export function $state<T>(_initialValue: T): T {
  // This function is never called at runtime - the compiler transforms it
  throw new Error('$state() is a compiler macro and should be transformed at compile time')
}

/**
 * Compiler macro for reactive effects.
 * This is transformed at compile time and should never be called at runtime.
 *
 * @example
 * ```tsx
 * $effect(() => {
 *   console.log('count changed:', count)
 * })
 * ```
 *
 * @public
 */
export function $effect(_fn: () => void | (() => void)): void {
  // This function is never called at runtime - the compiler transforms it
  throw new Error('$effect() is a compiler macro and should be transformed at compile time')
}
