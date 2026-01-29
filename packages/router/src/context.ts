/**
 * @fileoverview Router and Route contexts for @fictjs/router
 *
 * This module provides the context system that allows components to access
 * routing state without prop drilling. Uses Fict's context API.
 */

import { createContext, useContext } from '@fictjs/runtime'

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
import { stripBasePath, prependBasePath } from './utils'

// ============================================================================
// Router Context
// ============================================================================

/**
 * Default router context value (used when no router is present)
 */
const defaultRouterContext: RouterContextValue = {
  location: () => ({
    pathname: '/',
    search: '',
    hash: '',
    state: null,
    key: 'default',
  }),
  params: () => ({}),
  matches: () => [],
  navigate: () => {
    console.warn('[fict-router] No router found. Wrap your app in a <Router>')
  },
  isRouting: () => false,
  pendingLocation: () => null,
  base: '',
  resolvePath: (to: To) => (typeof to === 'string' ? to : to.pathname || '/'),
}

/**
 * Router context - provides access to router state
 */
export const RouterContext = createContext<RouterContextValue>(defaultRouterContext)
RouterContext.displayName = 'RouterContext'

/**
 * Use the router context
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
  resolvePath: (to: To) => (typeof to === 'string' ? to : to.pathname || '/'),
}

/**
 * Route context - provides access to current route match and data
 */
export const RouteContext = createContext<RouteContextValue>(defaultRouteContext)
RouteContext.displayName = 'RouteContext'

/**
 * Use the route context
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
  addHandler: () => () => {},
  confirm: async () => true,
}

export const BeforeLeaveContext = createContext<BeforeLeaveContextValue>(defaultBeforeLeaveContext)
BeforeLeaveContext.displayName = 'BeforeLeaveContext'

/**
 * Use the beforeLeave context
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
  return router.navigate
}

/**
 * Get the current location
 */
export function useLocation(): () => Location {
  const router = useRouter()
  return router.location
}

/**
 * Get the current route parameters
 */
export function useParams<P extends string = string>(): () => Params<P> {
  const router = useRouter()
  return router.params as () => Params<P>
}

/**
 * Get the current search parameters
 */
export function useSearchParams(): [
  () => URLSearchParams,
  (params: URLSearchParams | Record<string, string>, options?: { replace?: boolean }) => void,
] {
  const router = useRouter()

  const getSearchParams = () => {
    const location = router.location()
    return new URLSearchParams(location.search)
  }

  const setSearchParams = (
    params: URLSearchParams | Record<string, string>,
    options?: { replace?: boolean },
  ) => {
    const searchParams = params instanceof URLSearchParams ? params : new URLSearchParams(params)
    const search = searchParams.toString()

    const location = router.location()
    router.navigate(
      {
        pathname: location.pathname,
        search: search ? '?' + search : '',
        hash: location.hash,
      },
      { replace: options?.replace },
    )
  }

  return [getSearchParams, setSearchParams]
}

/**
 * Get the current route matches
 */
export function useMatches(): () => RouteMatch[] {
  const router = useRouter()
  return router.matches
}

/**
 * Check if currently routing (loading new route)
 */
export function useIsRouting(): () => boolean {
  const router = useRouter()
  return router.isRouting
}

/**
 * Get the pending navigation location (if any)
 */
export function usePendingLocation(): () => Location | null {
  const router = useRouter()
  return router.pendingLocation
}

/**
 * Get the preloaded data for the current route
 */
export function useRouteData<T = unknown>(): () => T | undefined {
  const route = useRoute()
  return route.data as () => T | undefined
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
  return (route as any).error?.()
}

/**
 * Resolve a path relative to the current route
 */
export function useResolvedPath(to: To | (() => To)): () => string {
  const route = useRoute()

  return () => {
    const target = typeof to === 'function' ? to() : to
    return route.resolvePath(target)
  }
}

/**
 * Check if a path matches the current location
 */
export function useMatch(path: string | (() => string)): () => RouteMatch | null {
  const router = useRouter()

  return () => {
    const targetPath = typeof path === 'function' ? path() : path
    const matches = router.matches()

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
 * Get the href for a given path (useful for SSR)
 */
export function useHref(to: To | (() => To)): () => string {
  const router = useRouter()

  return () => {
    const target = typeof to === 'function' ? to() : to

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
      const currentPathname = router.location().pathname
      const normalizedBase = router.base === '/' || router.base === '' ? '' : router.base

      // Check if current location is within the router's base
      if (normalizedBase && !currentPathname.startsWith(normalizedBase)) {
        // Current location is outside the base - return raw pathname + search/hash
        // without base manipulation to avoid generating incorrect hrefs
        return currentPathname + search + hash
      }

      resolved = stripBasePath(currentPathname, router.base)
    } else {
      resolved = router.resolvePath(pathname)
    }
    // Prepend base to get the full href, then append search/hash
    const baseHref = prependBasePath(resolved, router.base)
    return baseHref + search + hash
  }
}

/**
 * Check if a path is active (matches current location)
 */
export function useIsActive(
  to: To | (() => To),
  options?: { end?: boolean | undefined },
): () => boolean {
  const router = useRouter()

  return () => {
    const target = typeof to === 'function' ? to() : to

    // Resolve the target path relative to current location (handles relative paths)
    const resolvedTargetPath = router.resolvePath(target)

    // Strip base from current location pathname for comparison
    const currentPath = router.location().pathname
    if (router.base && currentPath !== router.base && !currentPath.startsWith(router.base + '/')) {
      return false
    }
    const currentPathWithoutBase = stripBasePath(currentPath, router.base)

    if (options?.end) {
      return currentPathWithoutBase === resolvedTargetPath
    }

    return (
      currentPathWithoutBase === resolvedTargetPath ||
      currentPathWithoutBase.startsWith(resolvedTargetPath + '/')
    )
  }
}

/**
 * Register a beforeLeave handler for the current route
 */
export function useBeforeLeave(handler: BeforeLeaveHandler): void {
  const context = useBeforeLeaveContext()
  const _cleanup = context.addHandler(handler)

  // Note: In Fict, cleanup happens automatically when the component unmounts
  // via the RootContext cleanup system
}
