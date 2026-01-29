/**
 * @fileoverview Scroll restoration utilities for @fictjs/router
 *
 * This module provides scroll position management including:
 * - Saving scroll positions per location key
 * - Restoring scroll on back/forward navigation
 * - Scrolling to top on new navigation
 * - Hash scrolling support (#section)
 */

import type { Location } from './types'
import { isBrowser } from './utils'

// ============================================================================
// Scroll Position Storage
// ============================================================================

/** Stored scroll positions keyed by location key */
const scrollPositions = new Map<string, { x: number; y: number }>()

/** Maximum number of positions to store to prevent memory leaks */
const MAX_STORED_POSITIONS = 100

/**
 * Save the current scroll position for a location
 */
export function saveScrollPosition(key: string): void {
  if (!isBrowser()) return

  scrollPositions.set(key, {
    x: window.scrollX,
    y: window.scrollY,
  })

  // Evict oldest entries if we exceed the limit
  if (scrollPositions.size > MAX_STORED_POSITIONS) {
    const firstKey = scrollPositions.keys().next().value
    if (firstKey) {
      scrollPositions.delete(firstKey)
    }
  }
}

/**
 * Get the saved scroll position for a location
 */
export function getSavedScrollPosition(key: string): { x: number; y: number } | undefined {
  return scrollPositions.get(key)
}

/**
 * Clear saved scroll position for a location
 */
export function clearScrollPosition(key: string): void {
  scrollPositions.delete(key)
}

/**
 * Clear all saved scroll positions
 */
export function clearAllScrollPositions(): void {
  scrollPositions.clear()
}

// ============================================================================
// Scroll Actions
// ============================================================================

/**
 * Scroll to a specific position
 */
export function scrollTo(x: number, y: number, behavior: ScrollBehavior = 'auto'): void {
  if (!isBrowser()) return

  window.scrollTo({
    left: x,
    top: y,
    behavior,
  })
}

/**
 * Scroll to top of the page
 */
export function scrollToTop(behavior: ScrollBehavior = 'auto'): void {
  scrollTo(0, 0, behavior)
}

/**
 * Scroll to an element by ID (hash navigation)
 */
export function scrollToHash(hash: string, behavior: ScrollBehavior = 'auto'): boolean {
  if (!isBrowser() || !hash) return false

  // Remove the leading #
  const id = hash.startsWith('#') ? hash.slice(1) : hash
  if (!id) return false

  const element = document.getElementById(id)
  if (element) {
    element.scrollIntoView({ behavior })
    return true
  }

  return false
}

/**
 * Restore scroll position for a location
 * Returns true if position was restored
 */
export function restoreScrollPosition(key: string): boolean {
  if (!isBrowser()) return false

  const position = scrollPositions.get(key)
  if (position) {
    // Use requestAnimationFrame to ensure DOM has updated
    requestAnimationFrame(() => {
      scrollTo(position.x, position.y)
    })
    return true
  }

  return false
}

// ============================================================================
// Scroll Restoration Manager
// ============================================================================

export interface ScrollRestorationOptions {
  /** Whether scroll restoration is enabled */
  enabled?: boolean
  /** Whether to restore scroll on back/forward navigation */
  restoreOnPop?: boolean
  /** Whether to scroll to top on push navigation */
  scrollToTopOnPush?: boolean
  /** Default scroll behavior */
  behavior?: ScrollBehavior
}

const defaultOptions: Required<ScrollRestorationOptions> = {
  enabled: true,
  restoreOnPop: true,
  scrollToTopOnPush: true,
  behavior: 'auto',
}

/**
 * Create a scroll restoration manager
 */
export function createScrollRestoration(options: ScrollRestorationOptions = {}) {
  const config = { ...defaultOptions, ...options }

  // Disable browser's native scroll restoration
  if (isBrowser() && 'scrollRestoration' in history) {
    history.scrollRestoration = 'manual'
  }

  /**
   * Handle navigation to save/restore scroll
   */
  function handleNavigation(
    from: Location | null,
    to: Location,
    action: 'PUSH' | 'REPLACE' | 'POP',
  ): void {
    if (!config.enabled || !isBrowser()) return

    // Save current position before navigating
    if (from?.key) {
      saveScrollPosition(from.key)
    }

    // Determine what scroll action to take
    if (action === 'POP' && config.restoreOnPop) {
      // Back/forward navigation - try to restore position
      if (!restoreScrollPosition(to.key)) {
        // No saved position, handle hash or scroll to top
        if (to.hash) {
          requestAnimationFrame(() => {
            if (!scrollToHash(to.hash, config.behavior)) {
              scrollToTop(config.behavior)
            }
          })
        } else {
          scrollToTop(config.behavior)
        }
      }
    } else if ((action === 'PUSH' || action === 'REPLACE') && config.scrollToTopOnPush) {
      // New navigation - handle hash or scroll to top
      requestAnimationFrame(() => {
        if (to.hash) {
          if (!scrollToHash(to.hash, config.behavior)) {
            scrollToTop(config.behavior)
          }
        } else {
          scrollToTop(config.behavior)
        }
      })
    }
  }

  /**
   * Reset scroll restoration to browser defaults
   */
  function reset(): void {
    if (isBrowser() && 'scrollRestoration' in history) {
      history.scrollRestoration = 'auto'
    }
    clearAllScrollPositions()
  }

  return {
    handleNavigation,
    saveScrollPosition,
    restoreScrollPosition,
    scrollToTop: () => scrollToTop(config.behavior),
    scrollToHash: (hash: string) => scrollToHash(hash, config.behavior),
    reset,
    config,
  }
}

/**
 * Default scroll restoration instance
 */
let defaultScrollRestoration: ReturnType<typeof createScrollRestoration> | null = null

/**
 * Get or create the default scroll restoration instance
 */
export function getScrollRestoration(): ReturnType<typeof createScrollRestoration> {
  if (!defaultScrollRestoration) {
    defaultScrollRestoration = createScrollRestoration()
  }
  return defaultScrollRestoration
}

/**
 * Configure the default scroll restoration
 */
export function configureScrollRestoration(options: ScrollRestorationOptions): void {
  defaultScrollRestoration = createScrollRestoration(options)
}
