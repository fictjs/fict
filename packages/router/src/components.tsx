/**
 * @fileoverview Router components for @fictjs/router
 *
 * This module provides the main Router, Routes, Route, and Outlet components.
 * These integrate with Fict's reactive system for fine-grained updates.
 */

import {
  createEffect,
  onCleanup,
  createMemo,
  batch,
  untrack,
  startTransition,
  Fragment,
  type FictNode,
  type Component,
} from '@fictjs/runtime'
import { createSignal } from '@fictjs/runtime/advanced'

import {
  RouterContext,
  RouteContext,
  BeforeLeaveContext,
  useRouter,
  useRoute,
  type BeforeLeaveContextValue,
} from './context'
import {
  createBrowserHistory,
  createHashHistory,
  createMemoryHistory,
  createStaticHistory,
} from './history'
import type {
  History,
  Location,
  RouteDefinition,
  RouteMatch,
  RouterContextValue,
  RouteContextValue,
  NavigateFunction,
  NavigateOptions,
  To,
  Params,
  BeforeLeaveHandler,
  BeforeLeaveEventArgs,
  MemoryRouterOptions,
  HashRouterOptions,
  RouterOptions,
} from './types'
import {
  compileRoute,
  createBranches,
  matchRoutes,
  resolvePath,
  createLocation,
  normalizePath,
  scrollToTop,
  isBrowser,
  stripBasePath,
  prependBasePath,
  locationsAreEqual,
} from './utils'

// Use Fict's signal for reactive state

// ============================================================================
// Internal State Types
// ============================================================================

interface RouterState {
  location: Location
  matches: RouteMatch[]
  isRouting: boolean
}

const isDevEnv =
  (typeof import.meta !== 'undefined' &&
    (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true) ||
  (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production')

let didWarnBaseMismatch = false

function hasBasePrefix(pathname: string, base: string): boolean {
  if (!base) return true
  return pathname === base || pathname.startsWith(base + '/')
}

function stripBaseOrWarn(pathname: string, base: string): string | null {
  if (!base) return pathname
  if (!hasBasePrefix(pathname, base)) {
    if (isDevEnv && !didWarnBaseMismatch) {
      didWarnBaseMismatch = true
      console.warn(
        `[fict-router] Location "${pathname}" does not start with base "${base}". No routes matched.`,
      )
    }
    return null
  }
  return stripBasePath(pathname, base)
}

function stripBaseIfPresent(pathname: string, base: string): string {
  if (!base) return pathname
  if (hasBasePrefix(pathname, base)) {
    return stripBasePath(pathname, base)
  }
  return pathname
}

// ============================================================================
// createRouter - Core router factory
// ============================================================================

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

      let defaultPrevented = false
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

    // Resolve the target path (relative to current path, without base)
    let targetPath: string
    const currentPathWithoutBase = stripBaseOrWarn(currentLocation.pathname, baseForStrip) || '/'

    if (typeof to === 'string') {
      if (options?.relative === 'route') {
        // Resolve relative to current route
        const matches = matchesSignal()
        const currentMatch = matches[matches.length - 1]
        const currentRoutePath = currentMatch?.pathname || currentPathWithoutBase
        targetPath = resolvePath(currentRoutePath, to)
      } else {
        // Resolve relative to current pathname
        targetPath = to.startsWith('/')
          ? stripBaseIfPresent(to, baseForStrip)
          : resolvePath(currentPathWithoutBase, to)
      }
    } else {
      const rawTargetPath = to.pathname || currentPathWithoutBase
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
      search: typeof to === 'string' ? '' : to.search || '',
      hash: typeof to === 'string' ? '' : to.hash || '',
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
      const canNavigate = await beforeLeave.confirm(targetLocation, currentLocation)
      if (!canNavigate) return

      // Start routing indicator
      isRoutingSignal(true)

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

        // Scroll handling
        if (options?.scroll !== false && isBrowser()) {
          scrollToTop()
        }

        // If navigation was blocked or no-op, reset routing state
        if (locationsAreEqual(prevLocation, history.location)) {
          isRoutingSignal(false)
        }
      })
    })
  }

  // Listen for history changes (browser back/forward AND navigate calls)
  // This is the single source of truth for location/matches updates
  const unlisten = history.listen(({ location: newLocation }) => {
    batch(() => {
      locationSignal(newLocation)
      const newMatches = matchWithBase(newLocation.pathname)
      matchesSignal(newMatches)
      isRoutingSignal(false)
    })
  })

  // State accessor
  const state = () => ({
    location: locationSignal(),
    matches: matchesSignal(),
    isRouting: isRoutingSignal(),
  })

  return {
    state,
    navigate,
    beforeLeave,
    cleanup: unlisten,
    normalizedBase: baseForStrip,
  }
}

// ============================================================================
// Router Component
// ============================================================================

interface BaseRouterProps {
  children?: FictNode
  base?: string
}

interface BrowserRouterProps extends BaseRouterProps, RouterOptions {}
interface HashRouterProps extends BaseRouterProps, HashRouterOptions {}
interface MemoryRouterProps extends BaseRouterProps, MemoryRouterOptions {}
interface StaticRouterProps extends BaseRouterProps {
  url: string
}

/**
 * Internal router component that sets up the context
 */
function RouterProvider(props: {
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

  const routerContext: RouterContextValue = {
    location: () => state().location,
    params: () => {
      const matches = state().matches
      // Use Record<string, string | undefined> for type precision
      const allParams: Record<string, string | undefined> = {}
      for (const match of matches) {
        Object.assign(allParams, match.params)
      }
      return allParams as Params
    },
    matches: () => state().matches,
    navigate,
    isRouting: () => state().isRouting,
    base: normalizedBase,
    resolvePath: (to: To) => {
      // Resolve path relative to current location (without base)
      const location = state().location
      const currentPathWithoutBase = stripBaseOrWarn(location.pathname, normalizedBase) || '/'
      const rawTargetPath = typeof to === 'string' ? to : to.pathname || '/'
      const targetPath = rawTargetPath.startsWith('/')
        ? stripBaseIfPresent(rawTargetPath, normalizedBase)
        : rawTargetPath
      return resolvePath(currentPathWithoutBase, targetPath)
    },
  }

  return (
    <RouterContext.Provider value={routerContext}>
      <BeforeLeaveContext.Provider value={beforeLeave}>
        {props.children}
      </BeforeLeaveContext.Provider>
    </RouterContext.Provider>
  )
}

/**
 * Browser Router - uses the History API
 */
export function Router(props: BrowserRouterProps & { children?: FictNode }) {
  const history = props.history || createBrowserHistory()
  const routes = extractRoutes(props.children)

  return (
    <RouterProvider history={history} routes={routes} base={props.base}>
      <Routes>{props.children}</Routes>
    </RouterProvider>
  )
}

/**
 * Hash Router - uses the URL hash
 */
export function HashRouter(props: HashRouterProps & { children?: FictNode }) {
  const hashOptions = props.hashType ? { hashType: props.hashType } : undefined
  const history = createHashHistory(hashOptions)
  const routes = extractRoutes(props.children)

  return (
    <RouterProvider history={history} routes={routes} base={props.base}>
      <Routes>{props.children}</Routes>
    </RouterProvider>
  )
}

/**
 * Memory Router - keeps history in memory (for testing/SSR)
 */
export function MemoryRouter(props: MemoryRouterProps & { children?: FictNode }) {
  const memoryOptions: { initialEntries?: string[]; initialIndex?: number } = {}
  if (props.initialEntries !== undefined) {
    memoryOptions.initialEntries = props.initialEntries
  }
  if (props.initialIndex !== undefined) {
    memoryOptions.initialIndex = props.initialIndex
  }
  const history = createMemoryHistory(
    Object.keys(memoryOptions).length > 0 ? memoryOptions : undefined,
  )
  const routes = extractRoutes(props.children)

  return (
    <RouterProvider history={history} routes={routes} base={props.base}>
      <Routes>{props.children}</Routes>
    </RouterProvider>
  )
}

/**
 * Static Router - for server-side rendering
 */
export function StaticRouter(props: StaticRouterProps & { children?: FictNode }) {
  const history = createStaticHistory(props.url)
  const routes = extractRoutes(props.children)

  return (
    <RouterProvider history={history} routes={routes} base={props.base}>
      <Routes>{props.children}</Routes>
    </RouterProvider>
  )
}

// ============================================================================
// Routes Component
// ============================================================================

interface RoutesProps {
  children?: FictNode
}

/**
 * Routes component - renders the matched route
 */
export function Routes(props: RoutesProps) {
  const router = useRouter()
  const parentRoute = useRoute()

  // Get routes from children
  const routes = extractRoutes(props.children)

  // Compile routes for matching
  const compiledRoutes = routes.map(r => compileRoute(r))
  const branches = createBranches(compiledRoutes)

  // Create reactive memo for current matches
  const currentMatches = createMemo(() => {
    const location = router.location()
    const parentMatch = parentRoute.match()
    const locationPath = stripBaseOrWarn(location.pathname, router.base)
    if (locationPath == null) return []

    // Calculate the remaining path after parent route
    let basePath = '/'
    if (parentMatch) {
      basePath = parentMatch.pathname
    }

    // Get path relative to parent
    const relativePath = locationPath.startsWith(basePath)
      ? locationPath.slice(basePath.length) || '/'
      : locationPath

    return matchRoutes(branches, relativePath) || []
  })

  // Render the matched routes
  return <>{renderMatches(currentMatches(), 0)}</>
}

/**
 * Render route matches recursively
 */
function renderMatches(matches: RouteMatch[], index: number): FictNode {
  if (index >= matches.length) {
    return null
  }

  const match = matches[index]!
  const route = match.route
  const router = useRouter()

  // Create route context for this level
  const routeContext: RouteContextValue = {
    match: () => match,
    data: () => undefined, // TODO: Implement preload data
    outlet: () => renderMatches(matches, index + 1),
    resolvePath: (to: To) => {
      const basePath = match.pathname
      const targetPath = typeof to === 'string' ? to : to.pathname || '/'
      return resolvePath(basePath, targetPath)
    },
  }

  // Determine what to render
  let content: FictNode = null

  if (route.component) {
    const Component = route.component
    content = (
      <Component params={match.params} location={router.location()} data={routeContext.data()}>
        <Outlet />
      </Component>
    )
  } else if (route.element) {
    content = route.element
  } else if (route.children) {
    // Layout route without component - just render outlet
    content = <Outlet />
  }

  return <RouteContext.Provider value={routeContext}>{content}</RouteContext.Provider>
}

// ============================================================================
// Route Component
// ============================================================================

interface RouteJSXProps {
  path?: string | undefined
  component?: Component<any> | undefined
  element?: FictNode
  children?: FictNode
  index?: boolean | undefined
  key?: string | undefined
}

/**
 * Route component - defines a route
 * This is a configuration component, it doesn't render anything directly.
 */
export function Route(_props: RouteJSXProps): FictNode {
  // Route components are declarative - they're processed by Routes/extractRoutes
  // They don't render anything themselves
  return null
}

// ============================================================================
// Outlet Component
// ============================================================================

/**
 * Outlet component - renders the child route
 */
export function Outlet(): FictNode {
  const route = useRoute()
  return <>{route.outlet()}</>
}

// ============================================================================
// Navigate Component
// ============================================================================

interface NavigateComponentProps {
  to: To
  replace?: boolean
  state?: unknown
}

/**
 * Navigate component - declarative navigation
 * Navigates immediately when rendered.
 */
export function Navigate(props: NavigateComponentProps): FictNode {
  const router = useRouter()

  // Navigate on mount
  createEffect(() => {
    router.navigate(props.to, {
      replace: props.replace ?? true,
      state: props.state,
    })
  })

  return null
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Extract route definitions from JSX children
 */
function extractRoutes(children: FictNode): RouteDefinition[] {
  const routes: RouteDefinition[] = []

  if (children == null) return routes

  const childArray = Array.isArray(children) ? children : [children]

  for (const child of childArray) {
    if (child == null || typeof child !== 'object') continue

    // Check if it's a Route element
    const vnode = child as { type?: unknown; props?: Record<string, unknown> }

    if (vnode.type === Route) {
      const props = vnode.props || {}
      const routeDef: RouteDefinition = {}
      if (props.path !== undefined) routeDef.path = props.path as string
      if (props.component !== undefined) routeDef.component = props.component as Component<any>
      if (props.element !== undefined) routeDef.element = props.element as FictNode
      if (props.index !== undefined) routeDef.index = props.index as boolean
      if (props.children) routeDef.children = extractRoutes(props.children as FictNode)
      routes.push(routeDef)
    } else if (vnode.type === Fragment && vnode.props?.children) {
      // Handle fragments
      routes.push(...extractRoutes(vnode.props.children as FictNode))
    }
  }

  return routes
}

// ============================================================================
// Programmatic Route Definition
// ============================================================================

/**
 * Create routes from a configuration array (alternative to JSX)
 */
export function createRoutes(routes: RouteDefinition[]): RouteDefinition[] {
  return routes
}

/**
 * Create a router with programmatic routes
 */
export function createRouter(
  routes: RouteDefinition[],
  options?: RouterOptions,
): {
  Router: Component<{ children?: FictNode }>
} {
  return {
    Router: (props: { children?: FictNode }) => {
      const history = options?.history || createBrowserHistory()

      return (
        <RouterProvider history={history} routes={routes} base={options?.base}>
          {props.children || <Routes>{routesToElements(routes)}</Routes>}
        </RouterProvider>
      )
    },
  }
}

/**
 * Convert route definitions to Route elements
 */
function routesToElements(routes: RouteDefinition[]): FictNode {
  return (
    <>
      {routes.map((route, i) => {
        const routeProps: RouteJSXProps = { key: route.key || `route-${i}` }
        if (route.path !== undefined) routeProps.path = route.path
        if (route.component !== undefined) routeProps.component = route.component
        if (route.element !== undefined) routeProps.element = route.element
        if (route.index !== undefined) routeProps.index = route.index
        if (route.children) routeProps.children = routesToElements(route.children)
        return <Route {...routeProps} />
      })}
    </>
  )
}
