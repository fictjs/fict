/**
 * @fileoverview Fict Plus - Async Utilities and Store
 *
 * This module exports utilities for async data handling:
 * - resource: Async data fetching with caching and Suspense support
 * - lazy: Code-splitting with lazy component loading
 * - $store: Re-exported for backward compatibility (prefer importing from 'fict')
 *
 * @public
 * @packageDocumentation
 */

// ============================================================================
// Store (re-exported for backward compatibility)
// ============================================================================

export { $store } from './store'

// ============================================================================
// Async Resource
// ============================================================================

export { resource } from './resource'
export type { ResourceResult, ResourceOptions, ResourceCacheOptions } from './resource'

// ============================================================================
// Lazy Loading
// ============================================================================

export { lazy } from './lazy'
export type { LazyModule } from './lazy'
