/**
 * @fileoverview Router components for @fictjs/router
 *
 * This module provides the main Router, Routes, Route, and Outlet components.
 * These integrate with Fict's reactive system for fine-grained updates.
 */

import {
  createEffect,
  Fragment,
  Suspense,
  ErrorBoundary,
  onCleanup,
  untrack,
  type FictNode,
  type Component,
} from '@fictjs/runtime'
import { createSignal, runInScope } from '@fictjs/runtime/advanced'

import { wrapAccessor } from './accessor-utils'
import { RouteContext, RouteErrorContext, useRouter, useRoute, readAccessor } from './context'
import {
  createBrowserHistory,
  createHashHistory,
  createMemoryHistory,
  createStaticHistory,
} from './history'
import { stripBaseOrWarn } from './router-internals'
import { RouterProvider } from './router-provider'
import type {
  RouteDefinition,
  Location,
  RouteMatch,
  RouteContextValue,
  To,
  Params,
  MemoryRouterOptions,
  HashRouterOptions,
  RouterOptions,
} from './types'
import { compileRoute, createBranches, hasPathPrefix, matchRoutes, resolvePath } from './utils'

// Use Fict's signal for reactive state

// ============================================================================
// Internal State Types
// ============================================================================

interface RouteDataState<T = unknown> {
  data: T | undefined
  error: unknown
  loading: boolean
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
 * Browser Router - uses the History API
 */
export function Router(props: BrowserRouterProps & { children?: FictNode }) {
  const ownsHistory = !props.history
  const history = props.history || createBrowserHistory()
  if (ownsHistory) onCleanup(() => history.destroy?.())
  const children = untrack(() => props.children)
  const routes = extractRoutes(children)

  return (
    <RouterProvider history={history} routes={routes} base={props.base}>
      <Routes routes={routes}>{props.children}</Routes>
    </RouterProvider>
  )
}

/**
 * Hash Router - uses the URL hash
 */
export function HashRouter(props: HashRouterProps & { children?: FictNode }) {
  const hashOptions = props.hashType ? { hashType: props.hashType } : undefined
  const history = createHashHistory(hashOptions)
  onCleanup(() => history.destroy?.())
  const children = untrack(() => props.children)
  const routes = extractRoutes(children)

  return (
    <RouterProvider history={history} routes={routes} base={props.base}>
      <Routes routes={routes}>{props.children}</Routes>
    </RouterProvider>
  )
}

/**
 * Memory Router - keeps history in memory (for testing/SSR)
 */
export function MemoryRouter(props: MemoryRouterProps & { children?: FictNode }) {
  const initialEntries = untrack(() => props.initialEntries)
  const initialIndex = untrack(() => props.initialIndex)
  const memoryOptions =
    initialEntries !== undefined || initialIndex !== undefined
      ? {
          ...(initialEntries !== undefined ? { initialEntries } : {}),
          ...(initialIndex !== undefined ? { initialIndex } : {}),
        }
      : undefined
  const history = createMemoryHistory(memoryOptions)
  onCleanup(() => history.destroy?.())
  const children = untrack(() => props.children)
  const routes = extractRoutes(children)

  return (
    <RouterProvider history={history} routes={routes} base={props.base}>
      <Routes routes={routes}>{props.children}</Routes>
    </RouterProvider>
  )
}

/**
 * Static Router - for server-side rendering
 */
export function StaticRouter(props: StaticRouterProps & { children?: FictNode }) {
  const url = untrack(() => props.url)
  const history = createStaticHistory(url)
  onCleanup(() => history.destroy?.())
  const children = untrack(() => props.children)
  const routes = extractRoutes(children)

  return (
    <RouterProvider history={history} routes={routes} base={props.base}>
      <Routes routes={routes}>{props.children}</Routes>
    </RouterProvider>
  )
}

// ============================================================================
// Routes Component
// ============================================================================

interface RoutesProps {
  children?: FictNode
  routes?: RouteDefinition[]
}

/**
 * Routes component - renders the matched route
 */
export function Routes(props: RoutesProps) {
  const router = useRouter()
  const parentRoute = useRoute()

  // Get routes from children
  const children = untrack(() => props.children)
  const routes = props.routes ?? extractRoutes(children)

  // Compile routes for matching
  const compiledRoutes = routes.map(r => compileRoute(r))
  const branches = createBranches(compiledRoutes)

  const currentMatches = createSignal<RouteMatch[]>([])

  // Update the active matches when router state changes.
  createEffect(() => {
    const pendingLocation = readAccessor(router.pendingLocation)
    const location = pendingLocation ?? readAccessor(router.location)
    const parentMatch = readAccessor(parentRoute.match)
    const base = readAccessor(router.base)
    const locationPath = stripBaseOrWarn(location.pathname, base)
    if (locationPath == null) {
      currentMatches([])
    } else {
      // Calculate the remaining path after parent route
      const basePath = parentMatch ? parentMatch.pathname : '/'

      // Get path relative to parent
      const relativePath = hasPathPrefix(locationPath, basePath)
        ? locationPath.slice(basePath.length) || '/'
        : locationPath

      currentMatches(matchRoutes(branches, relativePath) || [])
    }
  })

  return <CurrentMatchesView matches={currentMatches} />
}

// ============================================================================
// Route Component
// ============================================================================

interface RenderMatchesProps {
  matches: RouteMatch[]
  index: number
}

interface CurrentMatchesProps {
  matches: RouteMatch[] | (() => RouteMatch[])
}

function CurrentMatchesView(props: CurrentMatchesProps): FictNode {
  const matchesInput = untrack(() => props.matches)
  const matches = () => (typeof matchesInput === 'function' ? matchesInput() : matchesInput)

  return <>{matches().length > 0 ? renderMatches(matches(), 0) : null}</>
}

function RenderMatchesView(props: RenderMatchesProps): FictNode {
  const index = untrack(() => props.index)
  const match = props.matches.slice(index, index + 1)[0]!
  const route = match.route
  const router = useRouter()
  const hasPreload = typeof route.preload === 'function'

  // Create signals for route data
  const dataState = createSignal<RouteDataState>({
    data: undefined,
    error: undefined,
    loading: hasPreload,
  })

  // Token to prevent stale preload results from overwriting newer ones
  let preloadToken = 0

  // Load data if preload is defined
  runInScope(hasPreload, () => {
    // Trigger preload on initial render and when location changes
    createEffect(() => {
      const location = readAccessor(router.location)
      const preloadArgs = {
        params: match.params,
        location,
        intent: 'navigate' as const,
      }
      const preload = route.preload
      if (typeof preload === 'function') {
        // Increment token to invalidate any pending preloads
        const currentToken = ++preloadToken

        dataState({ data: undefined, error: undefined, loading: true })

        Promise.resolve(preload(preloadArgs))
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
      }
    })
  })

  const outletNode = <Outlet />

  // Determine what to render
  const renderContent = (): FictNode => {
    const state = dataState()
    const Component = route.component as
      | Component<{
          params: Params
          location: Location
          data: unknown
          children?: FictNode
        }>
      | undefined

    return state.error !== undefined && route.errorElement ? (
      route.errorElement
    ) : state.loading && route.loadingElement ? (
      route.loadingElement
    ) : Component ? (
      <Component params={match.params} location={readAccessor(router.location)} data={state.data}>
        {outletNode}
      </Component>
    ) : route.element ? (
      route.element
    ) : route.children ? (
      outletNode
    ) : null
  }

  // Create route context for this level
  const routeContext: RouteContextValue = {
    match: () => match,
    data: () => dataState().data,
    error: () => dataState().error,
    outlet: () =>
      index + 1 < props.matches.length ? (
        <RenderMatchesView matches={props.matches} index={index + 1} />
      ) : null,
    resolvePath: wrapAccessor((to: To) => {
      const basePath = match.pathname
      const targetPath = typeof to === 'string' ? to : to.pathname || '/'
      return resolvePath(basePath, targetPath)
    }),
  }

  const routeContent: FictNode = (
    <RouteContext.Provider value={routeContext}>{renderContent()}</RouteContext.Provider>
  )

  const errorBoundaryContent: FictNode = route.errorElement ? (
    <ErrorBoundary
      fallback={(err: unknown, reset?: () => void) => (
        <RouteErrorContext.Provider value={{ error: err, reset }}>
          {route.errorElement}
        </RouteErrorContext.Provider>
      )}
    >
      {routeContent}
    </ErrorBoundary>
  ) : (
    routeContent
  )

  return route.loadingElement ? (
    <Suspense fallback={route.loadingElement}>{errorBoundaryContent}</Suspense>
  ) : (
    errorBoundaryContent
  )
}

export function renderMatches(matches: RouteMatch[], index: number): FictNode {
  return <RenderMatchesView matches={matches} index={index} />
}

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
  matchFilters?: RouteDefinition['matchFilters']
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

export function Outlet(): FictNode {
  const route = useRoute()
  return readAccessor(route.outlet)
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
  const to = untrack(() => props.to)
  const replace = untrack(() => props.replace)
  const state = untrack(() => props.state)

  // Navigate on mount
  createEffect(() => {
    router.navigate(to, {
      replace: replace ?? true,
      state,
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
  const to = untrack(() => props.to)
  const push = untrack(() => props.push)
  const state = untrack(() => props.state)

  // Redirect on mount
  createEffect(() => {
    router.navigate(to, {
      replace: push !== true, // Replace by default, push only if explicitly requested
      state,
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
    const vnode = child as { type?: unknown; props?: Record<string, unknown>; key?: string }

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
      if (props.matchFilters !== undefined)
        routeDef.matchFilters = props.matchFilters as NonNullable<RouteDefinition['matchFilters']>
      const key = vnode.key ?? props.key
      if (key !== undefined) routeDef.key = String(key)
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
      const ownsHistory = !options?.history
      const history = options?.history || createBrowserHistory()
      if (ownsHistory) onCleanup(() => history.destroy?.())

      return (
        <RouterProvider history={history} routes={routes} base={options?.base}>
          {props.children || <Routes routes={routes} />}
        </RouterProvider>
      )
    },
  }
}
