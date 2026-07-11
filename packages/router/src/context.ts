/**
 * @fileoverview Router and Route contexts for @fictjs/router
 *
 * This module provides the context system that allows components to access
 * routing state without prop drilling. Uses Fict's context API.
 */

import { createContext, hasContext, onCleanup, useContext } from '@fictjs/runtime'

import { wrapAccessor, wrapValue } from './accessor-utils'
import { stripBaseIfPresent } from './router-internals'
import type {
  RouterContextValue,
  RouteContextValue,
  Location,
  Params,
  RouteMatch,
  NavigateFunction,
  To,
  BeforeLeaveHandler,
} from './types'
import { getExternalHref, hasPathPrefix, parseURL, stripBasePath, prependBasePath } from './utils'

// ============================================================================
// Router Context
// ============================================================================

export type MaybeAccessor<T> = T | (() => T)

export function readAccessor<T>(value: MaybeAccessor<T>): T {
  return typeof value === 'function' ? (value as () => T)() : value
}

/**
 * Default router context value (used when no router is present)
 */
const defaultLocation: Location = {
  pathname: '/',
  search: '',
  hash: '',
  state: null,
  key: 'default',
}

const defaultNavigate = wrapAccessor(((_toOrDelta: To | number) => {
  console.warn('[fict-router] No router found. Wrap your app in a <Router>')
}) as NavigateFunction)

const defaultResolvePath = wrapAccessor((to: To) => {
  return typeof to === 'string' ? to : to.pathname || '/'
})

const defaultRouterContext: RouterContextValue = {
  location: () => defaultLocation,
  params: () => ({}),
  matches: () => [],
  navigate: defaultNavigate,
  isRouting: () => false,
  pendingLocation: () => null,
  base: wrapValue(''),
  resolvePath: defaultResolvePath,
}

/**
 * Router context - provides access to router state
 */
export const RouterContext = createContext<RouterContextValue>(defaultRouterContext)
RouterContext.displayName = 'RouterContext'

/**
 * Use the router context
 */
/**
 * Use the router context
 *
 * @fictReturn { location: 'signal', params: 'signal', matches: 'signal', isRouting: 'signal', pendingLocation: 'signal' }
 */
export function useRouter(): RouterContextValue {
  return useContext(RouterContext)
}

// ============================================================================
// Route Context
// ============================================================================

/**
 * Default route context value (used when not inside a route)
 */
const defaultRouteContext: RouteContextValue = {
  match: () => undefined,
  data: () => undefined,
  outlet: () => null,
  resolvePath: wrapAccessor((to: To) => (typeof to === 'string' ? to : to.pathname || '/')),
}

/**
 * Route context - provides access to current route match and data
 */
export const RouteContext = createContext<RouteContextValue>(defaultRouteContext)
RouteContext.displayName = 'RouteContext'

/**
 * Use the route context
 *
 * @fictReturn { match: 'signal', data: 'signal', outlet: 'signal', error: 'signal' }
 */
export function useRoute(): RouteContextValue {
  return useContext(RouteContext)
}

// ============================================================================
// BeforeLeave Context
// ============================================================================

/**
 * BeforeLeave context for route guards
 */
export interface BeforeLeaveContextValue {
  addHandler: (handler: BeforeLeaveHandler) => () => void
  confirm: (to: Location, from: Location) => Promise<boolean>
}

const defaultBeforeLeaveContext: BeforeLeaveContextValue = {
  addHandler: wrapAccessor((_handler: BeforeLeaveHandler) => {
    return () => {}
  }),
  confirm: wrapAccessor((_to: Location, _from: Location) => {
    return Promise.resolve(true)
  }),
}

export const BeforeLeaveContext = createContext<BeforeLeaveContextValue>(defaultBeforeLeaveContext)
BeforeLeaveContext.displayName = 'BeforeLeaveContext'

/**
 * Use the beforeLeave context
 *
 * @fictReturn {}
 */
export function useBeforeLeaveContext(): BeforeLeaveContextValue {
  return useContext(BeforeLeaveContext)
}

// ============================================================================
// Route Error Context (for ErrorBoundary-caught errors)
// ============================================================================

/**
 * Context for passing render errors caught by ErrorBoundary to errorElement components.
 * This allows useRouteError() to access errors from both preload and render phases.
 */
export interface RouteErrorContextValue {
  error: unknown
  reset: (() => void) | undefined
}

const defaultRouteErrorContext: RouteErrorContextValue = {
  error: undefined,
  reset: undefined,
}

export const RouteErrorContext = createContext<RouteErrorContextValue>(defaultRouteErrorContext)
RouteErrorContext.displayName = 'RouteErrorContext'

// ============================================================================
// Navigation Hooks
// ============================================================================

/**
 * Get the navigate function
 */
export function useNavigate(): NavigateFunction {
  const router = useRouter()
  return readAccessor(router.navigate as MaybeAccessor<NavigateFunction>)
}

/**
 * Get the current location
 */
export function useLocation(): () => Location {
  const router = useRouter()
  return () => readAccessor(router.location)
}

/**
 * Get the current route parameters
 */
export function useParams<P extends string = string>(): () => Params<P> {
  const router = useRouter()
  return () => readAccessor(router.params)
}

/**
 * Get the current search parameters
 *
 * @fictReturn [0: 'signal']
 */
export function useSearchParams(): [
  () => URLSearchParams,
  (params: URLSearchParams | Record<string, string>, options?: { replace?: boolean }) => void,
] {
  const router = useRouter()

  const getSearchParams = () => {
    const location = readAccessor(router.location)
    return new URLSearchParams(location.search)
  }

  const setSearchParams = (
    params: URLSearchParams | Record<string, string>,
    options?: { replace?: boolean },
  ) => {
    const searchParams = params instanceof URLSearchParams ? params : new URLSearchParams(params)
    const search = searchParams.toString()

    const location = readAccessor(router.location)
    const navigate = readAccessor(router.navigate as MaybeAccessor<NavigateFunction>)
    navigate(
      {
        pathname: location.pathname,
        search: search ? '?' + search : '',
        hash: location.hash,
      },
      { replace: options?.replace },
    )
  }

  return [getSearchParams, wrapAccessor(setSearchParams)]
}

/**
 * Get the current route matches
 */
export function useMatches(): () => RouteMatch[] {
  const router = useRouter()
  return () => readAccessor(router.matches)
}

/**
 * Check if currently routing (loading new route)
 */
export function useIsRouting(): () => boolean {
  const router = useRouter()
  return () => readAccessor(router.isRouting)
}

/**
 * Get the pending navigation location (if any)
 */
export function usePendingLocation(): () => Location | null {
  const router = useRouter()
  return () => readAccessor(router.pendingLocation)
}

/**
 * Get the preloaded data for the current route
 */
export function useRouteData<T = unknown>(): () => T | undefined {
  const route = useRoute()
  return () => readAccessor(route.data as MaybeAccessor<T | undefined>)
}

/**
 * Get route error (for use in errorElement components)
 * This hook is used within an error boundary to access the caught error.
 * It returns errors from both preload phase (via route context) and
 * render phase (via ErrorBoundary context).
 *
 * @example
 * ```tsx
 * function RouteErrorPage() {
 *   const error = useRouteError()
 *   return (
 *     <div>
 *       <h1>Error</h1>
 *       <p>{error?.message || 'Unknown error'}</p>
 *     </div>
 *   )
 * }
 * ```
 */
export function useRouteError(): unknown {
  // First check RouteErrorContext for render errors caught by ErrorBoundary
  const errorContext = useContext(RouteErrorContext)
  if (errorContext.error !== undefined) {
    return errorContext.error
  }

  // Fall back to route context for preload errors
  const route = useRoute()
  const routeError = (route as any).error as MaybeAccessor<unknown> | undefined
  if (routeError === undefined) return undefined
  return readAccessor(routeError)
}

/**
 * Resolve a path relative to the current route
 */
export function useResolvedPath(to: To | (() => To)): () => string {
  const route = useRoute()

  return () => {
    const target = typeof to === 'function' ? to() : to
    const resolvePath = readAccessor(route.resolvePath as MaybeAccessor<(to: To) => string>)
    return resolvePath(target)
  }
}

/**
 * Check if a path matches the current location
 */
export function useMatch(path: string | (() => string)): () => RouteMatch | null {
  const router = useRouter()

  return () => {
    const targetPath = typeof path === 'function' ? path() : path
    const matches = readAccessor(router.matches)

    // Check if any match's pattern matches the target path
    for (const match of matches) {
      if (match.pattern === targetPath || match.pathname === targetPath) {
        return match
      }
    }

    return null
  }
}

// ============================================================================
// Helper Hooks
// ============================================================================

/**
 * Get the href for a given path (useful for SSR). Relative paths resolve from
 * the current route by default, or from the current location when no route
 * context is available. Pass `relative: 'path'` to select location-relative
 * resolution explicitly.
 */
export function useHref(
  to: To | (() => To),
  options?: { relative?: 'route' | 'path' | undefined },
): () => string {
  const router = useRouter()
  const route = useRoute()
  const hasRouteContext = hasContext(RouteContext)

  return () => {
    const target = typeof to === 'function' ? to() : to
    const externalHref = getExternalHref(target)
    if (externalHref !== null) return externalHref
    const base = readAccessor(router.base)

    // Extract pathname, search, and hash from target
    // For strings, we must extract WITHOUT normalizing to preserve relative paths
    let pathname: string
    let search = ''
    let hash = ''

    if (typeof target === 'string') {
      // Extract hash first
      let remaining = target
      const hashIndex = remaining.indexOf('#')
      if (hashIndex >= 0) {
        hash = remaining.slice(hashIndex)
        remaining = remaining.slice(0, hashIndex)
      }
      // Extract search
      const searchIndex = remaining.indexOf('?')
      if (searchIndex >= 0) {
        search = remaining.slice(searchIndex)
        remaining = remaining.slice(0, searchIndex)
      }
      // Keep empty string for search/hash-only targets
      pathname = remaining
    } else {
      // Keep empty string for search/hash-only targets
      pathname = target.pathname || ''
      search = target.search || ''
      hash = target.hash || ''
    }

    // For empty pathname (search/hash-only), use current location's pathname
    // Otherwise resolve the pathname (handles relative paths)
    let resolved: string
    if (pathname === '') {
      // Use current path for search/hash-only hrefs
      const currentPathname = readAccessor(router.location).pathname
      const normalizedBase = base === '/' || base === '' ? '' : base

      // Check if current location is within the router's base
      if (normalizedBase && !hasPathPrefix(currentPathname, normalizedBase)) {
        // Current location is outside the base - return raw pathname + search/hash
        // without base manipulation to avoid generating incorrect hrefs
        return currentPathname + search + hash
      }

      resolved = stripBasePath(currentPathname, base)
    } else {
      const usesRouteResolver = options?.relative !== 'path' && hasRouteContext
      const resolvePath = readAccessor(
        usesRouteResolver
          ? (route.resolvePath as MaybeAccessor<(to: To) => string>)
          : (router.resolvePath as MaybeAccessor<(to: To) => string>),
      )
      resolved = resolvePath(
        usesRouteResolver && pathname.startsWith('/')
          ? stripBaseIfPresent(pathname, base)
          : pathname,
      )
    }
    // Prepend base to get the full href, then append search/hash
    const baseHref = prependBasePath(resolved, base)
    return baseHref + search + hash
  }
}

/**
 * Check if a path is active (matches current location)
 */
export function useIsActive(
  to: To | (() => To),
  options?: {
    end?: boolean | undefined
    caseSensitive?: boolean | undefined
    relative?: 'route' | 'path' | undefined
  },
): () => boolean {
  const router = useRouter()
  const href = useHref(to, options)

  return () => {
    const targetHref = href()
    if (getExternalHref(targetHref) !== null) return false

    // Strip base from current location pathname for comparison
    const currentPath = readAccessor(router.location).pathname
    const base = readAccessor(router.base)
    if (base && !hasPathPrefix(currentPath, base)) {
      return false
    }
    let currentPathWithoutBase = stripBasePath(currentPath, base)
    let targetPath = stripBasePath(parseURL(targetHref).pathname, base)
    if (!options?.caseSensitive) {
      currentPathWithoutBase = currentPathWithoutBase.toLowerCase()
      targetPath = targetPath.toLowerCase()
    }

    if (options?.end) {
      return currentPathWithoutBase === targetPath
    }

    return (
      currentPathWithoutBase === targetPath || currentPathWithoutBase.startsWith(targetPath + '/')
    )
  }
}

/**
 * Register a beforeLeave handler for the current route
 */
export function useBeforeLeave(handler: BeforeLeaveHandler): void {
  const context = useBeforeLeaveContext()
  onCleanup(context.addHandler(handler))
}
