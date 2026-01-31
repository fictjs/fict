/**
 * @fileoverview Router components for @fictjs/router
 *
 * This module provides the main Router, Routes, Route, and Outlet components.
 * These integrate with Fict's reactive system for fine-grained updates.
 */

import {
  createEffect,
  createMemo,
  Fragment,
  Suspense,
  ErrorBoundary,
  type FictNode,
  type Component,
} from '@fictjs/runtime'
import { createSignal } from '@fictjs/runtime/advanced'

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
import { compileRoute, createBranches, matchRoutes, resolvePath } from './utils'

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
    const pendingLocation = readAccessor(router.pendingLocation)
    const location = pendingLocation ?? readAccessor(router.location)
    const parentMatch = readAccessor(parentRoute.match)
    const base = readAccessor(router.base)
    const locationPath = stripBaseOrWarn(location.pathname, base)
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
  const matches = currentMatches()
  return <>{matches.length > 0 ? renderMatches(matches, 0) : null}</>
}

// ============================================================================
// Route Component
// ============================================================================

export function renderMatches(matches: RouteMatch[], index: number): FictNode {
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
      const location = readAccessor(router.location)
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

  const outletNode = <Outlet />

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
      const Component = route.component as Component<{
        params: Params
        location: Location
        data: unknown
        children?: FictNode
      }>
      return (
        <Component params={match.params} location={readAccessor(router.location)} data={state.data}>
          {outletNode}
        </Component>
      )
    }
    if (route.element) {
      return route.element
    }
    if (route.children) {
      // Layout route without component - just render outlet
      return outletNode
    }

    return null
  }

  // Create route context for this level
  const routeContext: RouteContextValue = {
    match: () => match,
    data: () => dataState().data,
    error: () => dataState().error,
    outlet: () => (index + 1 < matches.length ? renderMatches(matches, index + 1) : null),
    resolvePath: wrapAccessor((to: To) => {
      const basePath = match.pathname
      const targetPath = typeof to === 'string' ? to : to.pathname || '/'
      return resolvePath(basePath, targetPath)
    }),
  }

  // Build the route content with context provider
  let content: FictNode = (
    <RouteContext.Provider value={routeContext}>{renderContent()}</RouteContext.Provider>
  )

  // Always wrap with ErrorBoundary if errorElement is defined
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
