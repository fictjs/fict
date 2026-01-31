import { batch, onCleanup, startTransition, untrack, type FictNode } from '@fictjs/runtime'
import { createSignal } from '@fictjs/runtime/advanced'
import { jsx } from '@fictjs/runtime/jsx-runtime'

import { wrapAccessor, wrapValue } from './accessor-utils'
import {
  BeforeLeaveContext,
  type BeforeLeaveContextValue,
  RouterContext,
  pushActiveBeforeLeave,
  pushActiveRouter,
  popActiveBeforeLeave,
  popActiveRouter,
} from './context'
import { stripBaseIfPresent, stripBaseOrWarn } from './router-internals'
import { getScrollRestoration } from './scroll'
import type {
  BeforeLeaveEventArgs,
  BeforeLeaveHandler,
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

  const beforeLeave: BeforeLeaveContextValue = {
    addHandler(handler: BeforeLeaveHandler) {
      beforeLeaveHandlers.add(handler)
      return () => beforeLeaveHandlers.delete(handler)
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

    if (typeof to === 'string') {
      // Empty pathname means search/hash-only navigation - keep current path
      if (toPathname === '') {
        targetPath = currentPathWithoutBase
      } else if (options?.relative === 'route') {
        // Resolve relative to current route
        const matches = matchesSignal()
        const currentMatch = matches[matches.length - 1]
        const currentRoutePath = currentMatch?.pathname || currentPathWithoutBase
        targetPath = resolvePath(currentRoutePath, toPathname)
      } else {
        // Resolve relative to current pathname
        // Only strip base if it's an absolute path
        targetPath = toPathname.startsWith('/')
          ? stripBaseIfPresent(toPathname, baseForStrip)
          : resolvePath(currentPathWithoutBase, toPathname)
      }
    } else {
      const rawTargetPath = toPathname || currentPathWithoutBase
      targetPath = stripBaseIfPresent(rawTargetPath, baseForStrip)
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

    // Check beforeLeave handlers
    untrack(async () => {
      if (beforeLeaveHandlers.size > 0) {
        pendingLocationSignal(targetLocation)
      }
      const canNavigate = await beforeLeave.confirm(targetLocation, currentLocation)
      if (!canNavigate) {
        return
      }

      // Start routing indicator and set pending location
      batch(() => {
        isRoutingSignal(true)
        pendingLocationSignal(targetLocation)
      })

      // Use transition for smooth updates
      // Note: We only push/replace to history here.
      // The actual signal updates happen in history.listen to avoid duplicates.
      startTransition(() => {
        const prevLocation = history.location
        if (options?.replace) {
          history.replace(targetLocation, finalState)
        } else {
          history.push(targetLocation, finalState)
        }

        // Scroll handling for programmatic navigation
        if (options?.scroll !== false && isBrowser()) {
          const scrollRestoration = getScrollRestoration()
          scrollRestoration.handleNavigation(
            prevLocation,
            history.location,
            options?.replace ? 'REPLACE' : 'PUSH',
          )
        }

        // If navigation was blocked or no-op, reset routing state
        if (locationsAreEqual(prevLocation, history.location)) {
          batch(() => {
            isRoutingSignal(false)
            pendingLocationSignal(null)
          })
        }
      })
    })
  }

  // Listen for history changes (browser back/forward AND navigate calls)
  // This is the single source of truth for location/matches updates
  const unlisten = history.listen(({ action, location: newLocation }) => {
    const prevLocation = locationSignal()

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
    }
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
    cleanup: unlisten,
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

  pushActiveRouter(routerContext)
  pushActiveBeforeLeave(beforeLeaveContext)
  onCleanup(() => {
    popActiveBeforeLeave(beforeLeaveContext)
    popActiveRouter(routerContext)
  })

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
