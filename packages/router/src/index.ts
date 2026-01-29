/**
 * @fileoverview @fictjs/router - Reactive router for Fict
 *
 * A full-featured router for Fict applications with:
 * - Fine-grained reactivity integration
 * - Nested routes and layouts
 * - Type-safe route parameters
 * - Data loading and preloading
 * - Route guards (beforeLeave)
 * - Multiple history modes (browser, hash, memory)
 * - Server-side rendering support
 *
 * @example
 * ```tsx
 * import { Router, Route, Link, useParams } from '@fictjs/router'
 *
 * function App() {
 *   return (
 *     <Router>
 *       <Route path="/" component={Home} />
 *       <Route path="/users/:id" component={UserProfile} />
 *       <Route path="/about" component={About} />
 *     </Router>
 *   )
 * }
 *
 * function UserProfile() {
 *   const params = useParams()
 *   return <div>User ID: {params().id}</div>
 * }
 * ```
 *
 * @packageDocumentation
 */

// ============================================================================
// Components
// ============================================================================

export {
  Router,
  HashRouter,
  MemoryRouter,
  StaticRouter,
  Routes,
  Route,
  Outlet,
  Navigate,
  createRoutes,
  createRouter,
} from './components'

export { Link, NavLink, Form } from './link'

// ============================================================================
// Hooks
// ============================================================================

export {
  useRouter,
  useRoute,
  useNavigate,
  useLocation,
  useParams,
  useSearchParams,
  useMatches,
  useIsRouting,
  useRouteData,
  useResolvedPath,
  useMatch,
  useHref,
  useIsActive,
  useBeforeLeave,
} from './context'

// ============================================================================
// History
// ============================================================================

export {
  createBrowserHistory,
  createHashHistory,
  createMemoryHistory,
  createStaticHistory,
} from './history'

// ============================================================================
// Data Loading
// ============================================================================

export {
  query,
  revalidate,
  action,
  getAction,
  useSubmission,
  useSubmissions,
  submitAction,
  preloadQuery,
  createPreload,
  createResource,
  cleanupDataUtilities,
} from './data'

// ============================================================================
// Utilities
// ============================================================================

export {
  normalizePath,
  joinPaths,
  resolvePath,
  createLocation,
  parseURL,
  createURL,
  parseSearchParams,
  stringifySearchParams,
  locationsAreEqual,
  stripBasePath,
  prependBasePath,
  matchRoutes,
  compileRoute,
  createBranches,
  scoreRoute,
  isServer,
  isBrowser,
} from './utils'

// ============================================================================
// Types
// ============================================================================

export type {
  // Location types
  Location,
  To,
  NavigationIntent,

  // Parameter types
  Params,
  SearchParams,
  MatchFilter,
  MatchFilters,

  // Route definition types
  RouteComponentProps,
  PreloadArgs,
  PreloadFunction,
  RouteDefinition,
  RouteProps,

  // Match types
  RouteMatch,
  CompiledRoute,
  RouteBranch,

  // Navigation types
  NavigateOptions,
  NavigateFunction,
  Navigation,

  // Context types
  RouterContextValue,
  RouteContextValue,

  // History types
  History,
  HistoryAction,
  HistoryListener,
  Blocker,

  // BeforeLeave types
  BeforeLeaveEventArgs,
  BeforeLeaveHandler,

  // Data loading types
  Submission,
  ActionFunction,
  Action,
  QueryFunction,
  QueryCacheEntry,

  // Router options
  RouterOptions,
  MemoryRouterOptions,
  HashRouterOptions,
} from './types'

export type { LinkProps, NavLinkProps, NavLinkRenderProps, FormProps } from './link'
export type { Resource } from './data'
