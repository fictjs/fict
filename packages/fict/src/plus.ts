/**
 * @fileoverview Fict Plus - Async Utilities and Store
 *
 * This module exports utilities for async data handling:
 * - resource: Async data fetching with caching and Suspense support
 * - lazy: Code-splitting with lazy component loading
 * - $store/$memo: Re-exported for backward compatibility (prefer importing from 'fict')
 *
 * @public
 * @packageDocumentation
 */

// ============================================================================
// Store/memo (re-exported for backward compatibility)
// ============================================================================

export { $store } from './store'
export { createMemo as $memo } from '@fictjs/runtime'

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
