/**
 * @fileoverview Fict Framework - Complete API
 *
 * This is the main entry point for the Fict framework.
 *
 * ## Recommended Import Pattern (v1.0+)
 *
 * ```typescript
 * // Core public API
 * import { $store, createSignal, render } from 'fict'
 *
 * // Async utilities
 * import { resource, lazy } from 'fict/plus'
 *
 * // Advanced APIs
 * import { createScope, createSelector } from 'fict/advanced'
 * ```
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
