import { batch, onCleanup, startTransition, untrack, type FictNode } from '@fictjs/runtime'
import { createSignal } from '@fictjs/runtime/advanced'
import { jsx } from '@fictjs/runtime/jsx-runtime'

import { wrapAccessor, wrapValue } from './accessor-utils'
import { BeforeLeaveContext, type BeforeLeaveContextValue, RouterContext } from './context'
import { stripBaseIfPresent, stripBaseOrWarn } from './router-internals'
import { getScrollRestoration } from './scroll'
import type {
  BeforeLeaveEventArgs,
  BeforeLeaveHandler,
  Blocker,
  History,
  Location,
  NavigateFunction,
  NavigateOptions,
  Params,
  RouteDefinition,
  RouteMatch,
  RouterContextValue,
  To,
} from './types'
import {
  createLocation,
  createBranches,
  compileRoute,
  isBrowser,
  locationsAreEqual,
  matchRoutes,
  normalizePath,
  prependBasePath,
  resolvePath,
} from './utils'

interface RouterState {
  location: Location
  matches: RouteMatch[]
  isRouting: boolean
  pendingLocation: Location | null
}

/**
 * Create a router instance with the given history and routes
 */
function createRouterState(
  history: History,
  routes: RouteDefinition[],
  base = '',
): {
  state: () => RouterState
  navigate: NavigateFunction
  beforeLeave: BeforeLeaveContextValue
  cleanup: () => void
  normalizedBase: string
} {
  // Normalize the base path
  const normalizedBase = normalizePath(base)
  const baseForStrip = normalizedBase === '/' ? '' : normalizedBase

  // Compile routes into branches for efficient matching
  const compiledRoutes = routes.map(r => compileRoute(r))
  const branches = createBranches(compiledRoutes)

  // Helper to match with base path stripped
  const matchWithBase = (pathname: string): RouteMatch[] => {
    const strippedPath = stripBaseOrWarn(pathname, baseForStrip)
    if (strippedPath == null) return []
    return matchRoutes(branches, strippedPath) || []
  }

  // Initial state
  const initialLocation = history.location
  const initialMatches = matchWithBase(initialLocation.pathname)

  // Reactive state using signals
  const locationSignal = createSignal<Location>(initialLocation)
  const matchesSignal = createSignal<RouteMatch[]>(initialMatches)
  const isRoutingSignal = createSignal<boolean>(false)
  const pendingLocationSignal = createSignal<Location | null>(null)

  // BeforeLeave handlers and navigation token for async ordering
  const beforeLeaveHandlers = new Set<BeforeLeaveHandler>()
  let navigationToken = 0
  let historyTransitionToken = 0
  let unblockHistory: (() => void) | null = null
  let pendingProgrammaticNavigation: { key: string; scroll: boolean } | null = null

  function resetPendingTransition(target?: Location) {
    if (target && pendingLocationSignal()?.key !== target.key) return
    batch(() => {
      isRoutingSignal(false)
      pendingLocationSignal(null)
    })
    if (!target || pendingProgrammaticNavigation?.key === target.key) {
      pendingProgrammaticNavigation = null
    }
  }

  const handleBlockedTransition: Blocker = transition => {
    const currentToken = ++historyTransitionToken
    const from = locationSignal()
    const target = transition.location

    pendingLocationSignal(target)

    untrack(async () => {
      try {
        const canNavigate = await beforeLeave.confirm(target, from)
        if (currentToken !== historyTransitionToken) return

        if (!canNavigate) {
          resetPendingTransition(target)
          return
        }

        batch(() => {
          isRoutingSignal(true)
          pendingLocationSignal(target)
        })

        if (transition.proceed) {
          transition.proceed()
          return
        }

        // Histories written against the original API do not expose `proceed`.
        // Temporarily remove only our blocker so their existing retry callback
        // can complete without recursively invoking the same guard.
        unblockHistory?.()
        unblockHistory = null
        transition.retry()
        ensureHistoryBlocker()
      } catch {
        if (currentToken === historyTransitionToken) resetPendingTransition(target)
      }
    })
  }

  function ensureHistoryBlocker() {
    if (!unblockHistory && beforeLeaveHandlers.size > 0) {
      unblockHistory = history.block(handleBlockedTransition)
    }
  }

  function removeHistoryBlocker() {
    unblockHistory?.()
    unblockHistory = null
  }

  const beforeLeave: BeforeLeaveContextValue = {
    addHandler(handler: BeforeLeaveHandler) {
      beforeLeaveHandlers.add(handler)
      ensureHistoryBlocker()
      return () => {
        beforeLeaveHandlers.delete(handler)
        if (beforeLeaveHandlers.size === 0) {
          navigationToken++
          historyTransitionToken++
          removeHistoryBlocker()
          resetPendingTransition()
        }
      }
    },
    async confirm(to: Location, from: Location): Promise<boolean> {
      if (beforeLeaveHandlers.size === 0) return true

      // Capture current token for this navigation
      const currentToken = ++navigationToken

      // Block by default when any beforeLeave handlers are registered.
      let defaultPrevented = true
      let retryRequested = false
      let forceRetry = false

      const event: BeforeLeaveEventArgs = {
        to,
        from,
        get defaultPrevented() {
          return defaultPrevented
        },
        preventDefault() {
          defaultPrevented = true
        },
        retry(force?: boolean) {
          retryRequested = true
          forceRetry = force ?? false
        },
      }

      for (const handler of beforeLeaveHandlers) {
        await handler(event)

        // Check if this navigation is still current (not superseded by newer navigation)
        if (currentToken !== navigationToken) {
          // This navigation was superseded, ignore its result
          return false
        }

        if (defaultPrevented && !retryRequested) {
          return false
        }
        if (retryRequested && forceRetry) {
          return true
        }
      }

      // Final check that this navigation is still current
      if (currentToken !== navigationToken) {
        return false
      }

      return !defaultPrevented || retryRequested
    },
  }

  // Navigation function
  const navigate: NavigateFunction = (toOrDelta: To | number, options?: NavigateOptions) => {
    if (typeof toOrDelta === 'number') {
      history.go(toOrDelta)
      return
    }

    const currentLocation = locationSignal()
    const to = toOrDelta

    // Extract pathname, search, and hash from string without normalizing pathname
    // This preserves relative paths like 'settings' vs '/settings'
    let toPathname: string
    let toSearch = ''
    let toHash = ''

    if (typeof to === 'string') {
      // Extract hash first
      let remaining = to
      const hashIndex = remaining.indexOf('#')
      if (hashIndex >= 0) {
        toHash = remaining.slice(hashIndex)
        remaining = remaining.slice(0, hashIndex)
      }
      // Extract search
      const searchIndex = remaining.indexOf('?')
      if (searchIndex >= 0) {
        toSearch = remaining.slice(searchIndex)
        remaining = remaining.slice(0, searchIndex)
      }
      // Remaining is the pathname (keep empty string for search/hash-only navigation)
      toPathname = remaining
    } else {
      toPathname = to.pathname || ''
      toSearch = to.search || ''
      toHash = to.hash || ''
    }

    // Resolve the target path (relative to current path, without base)
    let targetPath: string
    const currentPathWithoutBase = stripBaseOrWarn(currentLocation.pathname, baseForStrip) || '/'

    // Empty pathname means search/hash-only navigation - keep current path.
    if (toPathname === '') {
      targetPath = currentPathWithoutBase
    } else if (toPathname.startsWith('/')) {
      // Absolute targets are independent of the relative mode. Strip an
      // existing router base before it is applied uniformly below.
      targetPath = stripBaseIfPresent(toPathname, baseForStrip)
    } else {
      const matches = matchesSignal()
      const currentMatch = matches[matches.length - 1]
      const resolutionBase =
        options?.relative === 'route'
          ? currentMatch?.pathname || currentPathWithoutBase
          : currentPathWithoutBase
      targetPath = resolvePath(resolutionBase, toPathname)
    }

    // Create the full target location, preserving to.state and to.key
    // options.state overrides to.state if provided
    const toState = typeof to === 'object' ? to.state : undefined
    const toKey = typeof to === 'object' ? to.key : undefined
    const finalState = options?.state !== undefined ? options.state : toState

    // Build location object, only including key if defined
    const targetPathWithBase = prependBasePath(targetPath, baseForStrip)
    const locationSpec: Partial<Location> = {
      pathname: targetPathWithBase,
      search: toSearch,
      hash: toHash,
    }
    if (finalState !== undefined) {
      locationSpec.state = finalState
    }
    if (toKey !== undefined) {
      locationSpec.key = toKey
    }

    const targetLocation = createLocation(locationSpec, finalState, toKey)

    pendingProgrammaticNavigation = {
      key: targetLocation.key,
      scroll: options?.scroll !== false,
    }

    if (beforeLeaveHandlers.size > 0) {
      pendingLocationSignal(targetLocation)
    } else {
      // Start routing immediately when there is no asynchronous guard.
      batch(() => {
        isRoutingSignal(true)
        pendingLocationSignal(targetLocation)
      })
    }

    try {
      startTransition(() => {
        const prevLocation = history.location
        if (options?.replace) {
          history.replace(targetLocation, finalState)
        } else {
          history.push(targetLocation, finalState)
        }

        // Static or custom histories may decline a transition without notifying.
        if (beforeLeaveHandlers.size === 0 && locationsAreEqual(prevLocation, history.location)) {
          resetPendingTransition(targetLocation)
        }
      })
    } catch {
      resetPendingTransition(targetLocation)
    }
  }

  // Listen for history changes (browser back/forward AND navigate calls)
  // This is the single source of truth for location/matches updates
  const unlisten = history.listen(({ action, location: newLocation }) => {
    const prevLocation = locationSignal()
    const programmaticNavigation =
      pendingProgrammaticNavigation?.key === newLocation.key ? pendingProgrammaticNavigation : null

    batch(() => {
      locationSignal(newLocation)
      const newMatches = matchWithBase(newLocation.pathname)
      matchesSignal(newMatches)
      isRoutingSignal(false)
      pendingLocationSignal(null)
    })

    // Handle scroll restoration for POP navigation (back/forward)
    if (action === 'POP' && isBrowser()) {
      const scrollRestoration = getScrollRestoration()
      scrollRestoration.handleNavigation(prevLocation, newLocation, 'POP')
    } else if (programmaticNavigation?.scroll && isBrowser()) {
      const scrollRestoration = getScrollRestoration()
      scrollRestoration.handleNavigation(prevLocation, newLocation, action)
    }

    pendingProgrammaticNavigation = null
  })

  // State accessor
  const state = () => ({
    location: locationSignal(),
    matches: matchesSignal(),
    isRouting: isRoutingSignal(),
    pendingLocation: pendingLocationSignal(),
  })

  return {
    state,
    navigate,
    beforeLeave,
    cleanup: () => {
      navigationToken++
      historyTransitionToken++
      removeHistoryBlocker()
      unlisten()
    },
    normalizedBase: baseForStrip,
  }
}

export function RouterProvider(props: {
  history: History
  routes: RouteDefinition[]
  base?: string | undefined
  children?: FictNode
}) {
  const { state, navigate, beforeLeave, cleanup, normalizedBase } = createRouterState(
    props.history,
    props.routes,
    props.base,
  )

  onCleanup(cleanup)

  const beforeLeaveContext: BeforeLeaveContextValue = {
    addHandler: wrapAccessor(beforeLeave.addHandler),
    confirm: wrapAccessor(beforeLeave.confirm),
  }

  const resolvePathFn = (to: To) => {
    const location = state().location
    const currentPathWithoutBase = stripBaseOrWarn(location.pathname, normalizedBase) || '/'
    const rawTargetPath = typeof to === 'string' ? to : to.pathname || '/'
    const targetPath = rawTargetPath.startsWith('/')
      ? stripBaseIfPresent(rawTargetPath, normalizedBase)
      : rawTargetPath
    return resolvePath(currentPathWithoutBase, targetPath)
  }

  const routerContext: RouterContextValue = {
    location: () => state().location,
    params: () => {
      const matches = state().matches
      const allParams: Record<string, string | undefined> = {}
      for (const match of matches) {
        Object.assign(allParams, match.params)
      }
      return allParams as Params
    },
    matches: () => state().matches,
    navigate: wrapAccessor(navigate),
    isRouting: () => state().isRouting,
    pendingLocation: () => state().pendingLocation,
    base: wrapValue(normalizedBase),
    resolvePath: wrapAccessor(resolvePathFn),
  }

  const RouterContextProvider = RouterContext.Provider as unknown as (
    props: Record<string, unknown>,
  ) => FictNode
  const BeforeLeaveProvider = BeforeLeaveContext.Provider as unknown as (
    props: Record<string, unknown>,
  ) => FictNode

  return jsx(RouterContextProvider, {
    value: routerContext,
    children: jsx(BeforeLeaveProvider, {
      value: beforeLeaveContext,
      children: props.children,
    }),
  })
}
