/**
 * @fileoverview History implementations for @fictjs/router
 *
 * Provides browser history, hash history, and memory history implementations.
 * These handle the low-level navigation state management.
 */

import type { History, HistoryAction, HistoryListener, Location, To, Blocker } from './types'
import { createLocation, createURL, parseURL, createKey, normalizePath } from './utils'

// ============================================================================
// Shared Utilities
// ============================================================================

/**
 * Create a history state object
 */
function createHistoryState(
  location: Location,
  index: number,
): { usr: unknown; key: string; idx: number } {
  return {
    usr: location.state,
    key: location.key,
    idx: index,
  }
}

/**
 * Read a location from window.history.state
 */
function readLocation(
  state: { usr?: unknown; key?: string; idx?: number } | null,
  url: string,
): Location {
  const { pathname, search, hash } = parseURL(url)
  return {
    pathname,
    search,
    hash,
    state: state?.usr ?? null,
    key: state?.key ?? createKey(),
  }
}

// ============================================================================
// Browser History
// ============================================================================

/**
 * Create a browser history instance that uses the History API.
 * This is the standard history for most web applications.
 *
 * @throws Error if called in a non-browser environment (SSR)
 */
export function createBrowserHistory(): History {
  // SSR guard: throw clear error if window is not available
  if (typeof window === 'undefined') {
    throw new Error(
      '[fict-router] createBrowserHistory cannot be used in a server environment. ' +
        'Use createMemoryHistory or createStaticHistory for SSR.',
    )
  }

  const listeners = new Set<HistoryListener>()
  const blockers = new Set<Blocker>()
  let destroyed = false

  let action: HistoryAction = 'POP'
  let location = readLocation(
    window.history.state,
    window.location.pathname + window.location.search + window.location.hash,
  )
  let index = (window.history.state?.idx as number) ?? 0

  interface BlockedPopTransition {
    fromIndex: number
    toIndex: number
    location: Location
    restored: boolean
    retryRequested: 'retry' | 'proceed' | null
    cancelled: boolean
  }

  let blockedPop: BlockedPopTransition | null = null
  let restoringPop: BlockedPopTransition | null = null
  let forcedPopIndex: number | null = null

  function cancelBlockedPop() {
    if (blockedPop) blockedPop.cancelled = true
    blockedPop = null
    forcedPopIndex = null
  }

  function retryBlockedPop(transition: BlockedPopTransition) {
    if (transition.cancelled || blockedPop !== transition) return

    const delta = transition.toIndex - transition.fromIndex
    blockedPop = null
    if (transition.retryRequested === 'proceed') forcedPopIndex = transition.toIndex

    if (delta === 0) {
      forcedPopIndex = null
      action = 'POP'
      location = transition.location
      notifyListeners()
      return
    }

    window.history.go(delta)
  }

  // Handle popstate (back/forward navigation)
  function handlePopState(event: PopStateEvent) {
    const nextLocation = readLocation(
      event.state,
      window.location.pathname + window.location.search + window.location.hash,
    )
    const nextAction: HistoryAction = 'POP'
    const nextIndex = (event.state?.idx as number) ?? 0

    // A blocked POP first has to return the browser to the last accepted entry.
    // That restoration is an implementation detail and must not notify listeners
    // or run blockers a second time.
    if (restoringPop && nextIndex === restoringPop.fromIndex) {
      const transition = restoringPop
      restoringPop = null
      transition.restored = true

      if (transition.retryRequested !== null) {
        retryBlockedPop(transition)
      }
      return
    }

    // A forced retry is allowed through exactly once. This is used by the router
    // after its asynchronous beforeLeave handlers approve the original POP.
    if (forcedPopIndex !== null && nextIndex === forcedPopIndex) {
      forcedPopIndex = null
      action = nextAction
      location = nextLocation
      index = nextIndex
      notifyListeners()
      return
    }

    // Check blockers
    if (blockers.size > 0) {
      cancelBlockedPop()

      const transition: BlockedPopTransition = {
        fromIndex: index,
        toIndex: nextIndex,
        location: nextLocation,
        restored: nextIndex === index,
        retryRequested: null,
        cancelled: false,
      }
      blockedPop = transition

      let resumed = false
      const resume = (mode: 'retry' | 'proceed') => {
        if (resumed || transition.cancelled) return
        resumed = true
        transition.retryRequested = mode
        if (transition.restored) retryBlockedPop(transition)
      }
      const retry = () => resume('retry')
      const proceed = () => resume('proceed')

      for (const blocker of blockers) {
        blocker({
          action: nextAction,
          location: nextLocation,
          retry,
          proceed,
        })
        break
      }

      if (nextIndex !== index) {
        restoringPop = transition
        // Restore the previous entry while the asynchronous blocker decides.
        window.history.go(index - nextIndex)
      } else if (transition.retryRequested !== null) {
        retryBlockedPop(transition)
      }
      return
    }

    cancelBlockedPop()
    action = nextAction
    location = nextLocation
    index = nextIndex

    notifyListeners()
  }

  window.addEventListener('popstate', handlePopState)

  function notifyListeners() {
    for (const listener of listeners) {
      listener({ action, location })
    }
  }

  function push(to: To, state?: unknown, force = false) {
    const nextLocation = createLocation(to, state)
    const nextAction: HistoryAction = 'PUSH'

    // Check blockers
    if (!force && blockers.size > 0) {
      let resumed = false
      const retry = () => {
        if (resumed) return
        resumed = true
        push(to, state)
      }
      const proceed = () => {
        if (resumed) return
        resumed = true
        push(to, state, true)
      }

      for (const blocker of blockers) {
        blocker({
          action: nextAction,
          location: nextLocation,
          retry,
          proceed,
        })
        break
      }

      return
    }

    cancelBlockedPop()
    action = nextAction
    location = nextLocation
    index++

    const historyState = createHistoryState(location, index)
    window.history.pushState(historyState, '', createURL(location))

    notifyListeners()
  }

  function replace(to: To, state?: unknown, force = false) {
    const nextLocation = createLocation(to, state)
    const nextAction: HistoryAction = 'REPLACE'

    // Check blockers
    if (!force && blockers.size > 0) {
      let resumed = false
      const retry = () => {
        if (resumed) return
        resumed = true
        replace(to, state)
      }
      const proceed = () => {
        if (resumed) return
        resumed = true
        replace(to, state, true)
      }

      for (const blocker of blockers) {
        blocker({
          action: nextAction,
          location: nextLocation,
          retry,
          proceed,
        })
        break
      }

      return
    }

    cancelBlockedPop()
    action = nextAction
    location = nextLocation

    const historyState = createHistoryState(location, index)
    window.history.replaceState(historyState, '', createURL(location))

    notifyListeners()
  }

  function go(delta: number) {
    window.history.go(delta)
  }

  // Initialize history state if not set
  if (window.history.state === null) {
    const historyState = createHistoryState(location, index)
    window.history.replaceState(historyState, '', createURL(location))
  }

  return {
    get action() {
      return action
    },
    get location() {
      return location
    },
    push,
    replace,
    go,
    back() {
      go(-1)
    },
    forward() {
      go(1)
    },
    listen(listener: HistoryListener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    createHref(to: To) {
      const loc = typeof to === 'string' ? parseURL(to) : to
      return createURL(loc as Location)
    },
    block(blocker: Blocker) {
      blockers.add(blocker)

      // Set up beforeunload handler if this is the first blocker
      if (blockers.size === 1) {
        window.addEventListener('beforeunload', handleBeforeUnload)
      }

      return () => {
        blockers.delete(blocker)
        if (blockers.size === 0) {
          window.removeEventListener('beforeunload', handleBeforeUnload)
        }
      }
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      window.removeEventListener('popstate', handlePopState)
      window.removeEventListener('beforeunload', handleBeforeUnload)
      listeners.clear()
      blockers.clear()
    },
  }
}

function handleBeforeUnload(event: BeforeUnloadEvent) {
  event.preventDefault()
  // Modern browsers ignore the return value, but we set it anyway
  event.returnValue = ''
}

// ============================================================================
// Hash History
// ============================================================================

/**
 * Create a hash history instance that uses the URL hash.
 * Useful for static file hosting or when you can't configure server-side routing.
 *
 * @throws Error if called in a non-browser environment (SSR)
 */
export function createHashHistory(options: { hashType?: 'slash' | 'noslash' } = {}): History {
  // SSR guard: throw clear error if window is not available
  if (typeof window === 'undefined') {
    throw new Error(
      '[fict-router] createHashHistory cannot be used in a server environment. ' +
        'Use createMemoryHistory or createStaticHistory for SSR.',
    )
  }

  const { hashType = 'slash' } = options
  const listeners = new Set<HistoryListener>()
  const blockers = new Set<Blocker>()
  let destroyed = false

  let action: HistoryAction = 'POP'
  let location = readHashLocation()
  let index = 0

  function readHashLocation(): Location {
    let hash = window.location.hash.slice(1) // Remove the #

    // Handle hash type
    if (hashType === 'slash' && !hash.startsWith('/')) {
      hash = '/' + hash
    } else if (hashType === 'noslash' && hash.startsWith('/')) {
      hash = hash.slice(1)
    }

    const { pathname, search, hash: innerHash } = parseURL(hash || '/')

    return {
      pathname: normalizePath(pathname),
      search,
      hash: innerHash,
      state: window.history.state?.usr ?? null,
      key: window.history.state?.key ?? createKey(),
    }
  }

  function createHashHref(location: Location): string {
    const url = createURL(location)
    if (hashType === 'noslash') {
      return '#' + url.slice(1) // Remove leading /
    }
    return '#' + url
  }

  function handleHashChange() {
    const nextLocation = readHashLocation()
    const nextAction: HistoryAction = 'POP'

    // Check blockers
    if (blockers.size > 0) {
      let blocked = false
      const retry = () => {
        window.location.hash = createHashHref(nextLocation)
      }

      for (const blocker of blockers) {
        blocker({
          action: nextAction,
          location: nextLocation,
          retry,
        })
        blocked = true
        break
      }

      if (blocked) {
        // Restore the previous hash
        window.location.hash = createHashHref(location)
        return
      }
    }

    action = nextAction
    location = nextLocation

    notifyListeners()
  }

  window.addEventListener('hashchange', handleHashChange)

  function notifyListeners() {
    for (const listener of listeners) {
      listener({ action, location })
    }
  }

  function push(to: To, state?: unknown, force = false) {
    const nextLocation = createLocation(to, state)
    const nextAction: HistoryAction = 'PUSH'

    // Check blockers
    if (!force && blockers.size > 0) {
      let resumed = false
      const retry = () => {
        if (resumed) return
        resumed = true
        push(to, state)
      }
      const proceed = () => {
        if (resumed) return
        resumed = true
        push(to, state, true)
      }

      for (const blocker of blockers) {
        blocker({
          action: nextAction,
          location: nextLocation,
          retry,
          proceed,
        })
        break
      }

      return
    }

    action = nextAction
    location = nextLocation
    index++

    const historyState = createHistoryState(location, index)
    window.history.pushState(historyState, '', createHashHref(location))

    notifyListeners()
  }

  function replace(to: To, state?: unknown, force = false) {
    const nextLocation = createLocation(to, state)
    const nextAction: HistoryAction = 'REPLACE'

    // Check blockers
    if (!force && blockers.size > 0) {
      let resumed = false
      const retry = () => {
        if (resumed) return
        resumed = true
        replace(to, state)
      }
      const proceed = () => {
        if (resumed) return
        resumed = true
        replace(to, state, true)
      }

      for (const blocker of blockers) {
        blocker({
          action: nextAction,
          location: nextLocation,
          retry,
          proceed,
        })
        break
      }

      return
    }

    action = nextAction
    location = nextLocation

    const historyState = createHistoryState(location, index)
    window.history.replaceState(historyState, '', createHashHref(location))

    notifyListeners()
  }

  function go(delta: number) {
    window.history.go(delta)
  }

  return {
    get action() {
      return action
    },
    get location() {
      return location
    },
    push,
    replace,
    go,
    back() {
      go(-1)
    },
    forward() {
      go(1)
    },
    listen(listener: HistoryListener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    createHref(to: To) {
      const loc = createLocation(to)
      return createHashHref(loc)
    },
    block(blocker: Blocker) {
      blockers.add(blocker)

      if (blockers.size === 1) {
        window.addEventListener('beforeunload', handleBeforeUnload)
      }

      return () => {
        blockers.delete(blocker)
        if (blockers.size === 0) {
          window.removeEventListener('beforeunload', handleBeforeUnload)
        }
      }
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      window.removeEventListener('hashchange', handleHashChange)
      window.removeEventListener('beforeunload', handleBeforeUnload)
      listeners.clear()
      blockers.clear()
    },
  }
}

// ============================================================================
// Memory History
// ============================================================================

/**
 * Create a memory history instance that keeps history in memory.
 * Useful for testing and server-side rendering.
 */
export function createMemoryHistory(
  options: {
    initialEntries?: string[]
    initialIndex?: number
  } = {},
): History {
  const { initialEntries = ['/'], initialIndex } = options
  const listeners = new Set<HistoryListener>()
  const blockers = new Set<Blocker>()
  const normalizedInitialEntries = initialEntries.length > 0 ? initialEntries : ['/']

  // Initialize entries
  const entries: Location[] = normalizedInitialEntries.map((entry, i) =>
    createLocation(entry, null, `${i}`),
  )

  let index = initialIndex ?? entries.length - 1
  let action: HistoryAction = 'POP'

  // Clamp index to valid range
  index = Math.max(0, Math.min(index, entries.length - 1))

  function notifyListeners() {
    const location = entries[index]!
    for (const listener of listeners) {
      listener({ action, location })
    }
  }

  function push(to: To, state?: unknown, force = false) {
    const nextLocation = createLocation(to, state)
    const nextAction: HistoryAction = 'PUSH'

    // Check blockers
    if (!force && blockers.size > 0) {
      let resumed = false
      const retry = () => {
        if (resumed) return
        resumed = true
        push(to, state)
      }
      const proceed = () => {
        if (resumed) return
        resumed = true
        push(to, state, true)
      }

      for (const blocker of blockers) {
        blocker({
          action: nextAction,
          location: nextLocation,
          retry,
          proceed,
        })
        break
      }

      return
    }

    action = nextAction

    // Remove any entries after the current index
    entries.splice(index + 1)

    // Add the new entry
    entries.push(nextLocation)
    index = entries.length - 1

    notifyListeners()
  }

  function replace(to: To, state?: unknown, force = false) {
    const nextLocation = createLocation(to, state)
    const nextAction: HistoryAction = 'REPLACE'

    // Check blockers
    if (!force && blockers.size > 0) {
      let resumed = false
      const retry = () => {
        if (resumed) return
        resumed = true
        replace(to, state)
      }
      const proceed = () => {
        if (resumed) return
        resumed = true
        replace(to, state, true)
      }

      for (const blocker of blockers) {
        blocker({
          action: nextAction,
          location: nextLocation,
          retry,
          proceed,
        })
        break
      }

      return
    }

    action = nextAction
    entries[index] = nextLocation

    notifyListeners()
  }

  function go(delta: number, force = false) {
    const nextIndex = Math.max(0, Math.min(index + delta, entries.length - 1))

    if (nextIndex === index) return

    const nextLocation = entries[nextIndex]!
    const nextAction: HistoryAction = 'POP'

    // Check blockers
    if (!force && blockers.size > 0) {
      let resumed = false
      const retry = () => {
        if (resumed) return
        resumed = true
        go(delta)
      }
      const proceed = () => {
        if (resumed) return
        resumed = true
        go(delta, true)
      }

      for (const blocker of blockers) {
        blocker({
          action: nextAction,
          location: nextLocation,
          retry,
          proceed,
        })
        break
      }

      return
    }

    action = nextAction
    index = nextIndex

    notifyListeners()
  }

  return {
    get action() {
      return action
    },
    get location() {
      return entries[index]!
    },
    push,
    replace,
    go,
    back() {
      go(-1)
    },
    forward() {
      go(1)
    },
    listen(listener: HistoryListener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    createHref(to: To) {
      const loc = typeof to === 'string' ? parseURL(to) : to
      return createURL(loc as Location)
    },
    block(blocker: Blocker) {
      blockers.add(blocker)
      return () => blockers.delete(blocker)
    },
    destroy() {
      listeners.clear()
      blockers.clear()
    },
  }
}

// ============================================================================
// Static History (for SSR)
// ============================================================================

/**
 * Create a static history for server-side rendering.
 * This history doesn't support navigation and always returns the initial location.
 */
export function createStaticHistory(url: string): History {
  const location = createLocation(url)

  return {
    get action(): HistoryAction {
      return 'POP'
    },
    get location() {
      return location
    },
    push() {
      // No-op on server
      console.warn('[fict-router] Cannot push on static history (SSR)')
    },
    replace() {
      // No-op on server
      console.warn('[fict-router] Cannot replace on static history (SSR)')
    },
    go() {
      // No-op on server
      console.warn('[fict-router] Cannot go on static history (SSR)')
    },
    back() {
      // No-op on server
    },
    forward() {
      // No-op on server
    },
    listen() {
      // No-op on server
      return () => {}
    },
    createHref(to: To) {
      const loc = typeof to === 'string' ? parseURL(to) : to
      return createURL(loc as Location)
    },
    block() {
      // No-op on server
      return () => {}
    },
    destroy() {
      // No resources to release on the server.
    },
  }
}
