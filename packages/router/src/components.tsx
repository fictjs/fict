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
  Suspense,
  ErrorBoundary,
  type FictNode,
  type Component,
} from '@fictjs/runtime'
import { createSignal } from '@fictjs/runtime/advanced'

import {
  RouterContext,
  RouteContext,
  BeforeLeaveContext,
  RouteErrorContext,
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
  isBrowser,
  stripBasePath,
  prependBasePath,
  locationsAreEqual,
} from './utils'
import { getScrollRestoration } from './scroll'

// Use Fict's signal for reactive state

// ============================================================================
// Internal State Types
// ============================================================================

interface RouterState {
  location: Location
  matches: RouteMatch[]
  isRouting: boolean
  pendingLocation: Location | null
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
      const canNavigate = await beforeLeave.confirm(targetLocation, currentLocation)
      if (!canNavigate) {
        pendingLocationSignal(null)
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
    pendingLocation: () => state().pendingLocation,
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
 * Route data state for preloading
 */
interface RouteDataState<T = unknown> {
  data: T | undefined
  error: unknown
  loading: boolean
}

/**
 * Render route matches recursively with data loading support
 */
function renderMatches(matches: RouteMatch[], index: number): FictNode {
  if (index >= matches.length) {
    return null
  }

  const match = matches[index]!
  const route = match.route
  const router = useRouter()

  // Create signals for route data
  const dataState = createSignal<RouteDataState>({
    data: undefined,
    error: undefined,
    loading: !!route.preload,
  })

  // Token to prevent stale preload results from overwriting newer ones
  let preloadToken = 0

  // Load data if preload is defined
  if (route.preload) {
    // Trigger preload on initial render and when location changes
    createEffect(() => {
      const location = router.location()
      const preloadArgs = {
        params: match.params,
        location,
        intent: 'navigate' as const,
      }

      // Increment token to invalidate any pending preloads
      const currentToken = ++preloadToken

      dataState({ data: undefined, error: undefined, loading: true })

      Promise.resolve(route.preload!(preloadArgs))
        .then(result => {
          // Only apply result if this preload is still current
          if (currentToken === preloadToken) {
            dataState({ data: result, error: undefined, loading: false })
          }
        })
        .catch(error => {
          // Only apply error if this preload is still current
          if (currentToken === preloadToken) {
            dataState({ data: undefined, error, loading: false })
          }
        })
    })
  }

  // Create route context for this level
  const routeContext: RouteContextValue = {
    match: () => match,
    data: () => dataState().data,
    error: () => dataState().error,
    outlet: () => renderMatches(matches, index + 1),
    resolvePath: (to: To) => {
      const basePath = match.pathname
      const targetPath = typeof to === 'string' ? to : to.pathname || '/'
      return resolvePath(basePath, targetPath)
    },
  }

  // Determine what to render
  const renderContent = (): FictNode => {
    const state = dataState()

    // If there's an error and an errorElement, render it
    if (state.error !== undefined && route.errorElement) {
      return route.errorElement
    }

    // If loading and there's a loadingElement, render it
    if (state.loading && route.loadingElement) {
      return route.loadingElement
    }

    // Render the normal content
    if (route.component) {
      const Component = route.component
      return (
        <Component params={match.params} location={router.location()} data={state.data}>
          <Outlet />
        </Component>
      )
    } else if (route.element) {
      return route.element
    } else if (route.children) {
      // Layout route without component - just render outlet
      return <Outlet />
    }

    return null
  }

  // Build the route content with context provider
  let content: FictNode = (
    <RouteContext.Provider value={routeContext}>{renderContent()}</RouteContext.Provider>
  )

  // Always wrap with ErrorBoundary if errorElement is defined
  // This catches both preload errors (handled in renderContent) AND render errors from components
  // Use a function fallback to pass the error via RouteErrorContext for useRouteError()
  if (route.errorElement) {
    content = (
      <ErrorBoundary
        fallback={(err: unknown, reset?: () => void) => (
          <RouteErrorContext.Provider value={{ error: err, reset }}>
            {route.errorElement}
          </RouteErrorContext.Provider>
        )}
      >
        {content}
      </ErrorBoundary>
    )
  }

  // If route has loadingElement and component uses Suspense internally
  if (route.loadingElement) {
    content = <Suspense fallback={route.loadingElement}>{content}</Suspense>
  }

  return content
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
  preload?:
    | ((args: {
        params: Params
        location: Location
        intent: 'initial' | 'navigate' | 'native' | 'preload'
      }) => unknown | Promise<unknown>)
    | undefined
  errorElement?: FictNode
  loadingElement?: FictNode
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
// Redirect Component
// ============================================================================

interface RedirectProps {
  /** Target path to redirect to */
  to: To
  /** Path pattern that triggers this redirect (optional, for declarative redirects) */
  from?: string
  /** State to pass with the redirect */
  state?: unknown
  /** Whether to replace or push to history (default: true) */
  push?: boolean
}

/**
 * Redirect component - declarative redirect
 *
 * Unlike Navigate, Redirect is specifically for redirect scenarios:
 * - Always replaces by default (unless push=true)
 * - Can be used in route definitions with a `from` pattern
 * - Semantically indicates a redirect rather than navigation
 *
 * @example
 * ```tsx
 * // Basic redirect (replaces current entry)
 * <Redirect to="/login" />
 *
 * // Redirect with state
 * <Redirect to="/login" state={{ from: location.pathname }} />
 *
 * // Push instead of replace
 * <Redirect to="/new-page" push />
 *
 * // In route definitions (redirect old paths)
 * <Route path="/old-path" element={<Redirect to="/new-path" />} />
 * ```
 */
export function Redirect(props: RedirectProps): FictNode {
  const router = useRouter()

  // Redirect on mount
  createEffect(() => {
    router.navigate(props.to, {
      replace: props.push !== true, // Replace by default, push only if explicitly requested
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
      if (props.preload !== undefined)
        routeDef.preload = props.preload as NonNullable<RouteDefinition['preload']>
      if (props.errorElement !== undefined) routeDef.errorElement = props.errorElement as FictNode
      if (props.loadingElement !== undefined)
        routeDef.loadingElement = props.loadingElement as FictNode
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
