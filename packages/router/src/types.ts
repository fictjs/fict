/**
 * @fileoverview Core type definitions for @fictjs/router
 *
 * This module defines the fundamental types used throughout the router.
 * Designed to integrate seamlessly with Fict's reactive system.
 */

import type { FictNode, Component } from '@fictjs/runtime'

// ============================================================================
// Location Types
// ============================================================================

/**
 * Represents a location in the router.
 * Similar to window.location but with reactive support.
 */
export interface Location {
  /** The pathname portion of the URL (e.g., "/users/123") */
  pathname: string
  /** The search/query portion of the URL (e.g., "?page=1") */
  search: string
  /** The hash portion of the URL (e.g., "#section") */
  hash: string
  /** State associated with this location */
  state: unknown
  /** Unique key for this location entry */
  key: string
}

/**
 * Target for navigation - can be a string path or a partial location object
 */
export type To = string | Partial<Location>

/**
 * Navigation intent type
 */
export type NavigationIntent = 'initial' | 'navigate' | 'native' | 'preload'

// ============================================================================
// Parameter Types
// ============================================================================

/**
 * Route parameters extracted from the URL
 */
export type Params<Key extends string = string> = Readonly<Record<Key, string | undefined>>

/**
 * Search parameters from the query string
 */
export type SearchParams = URLSearchParams

/**
 * Match filter for validating route parameters
 */
export type MatchFilter<T = string> = RegExp | readonly T[] | ((value: string) => boolean)

/**
 * Match filters for route parameters
 */
export type MatchFilters<P extends string = string> = Partial<Record<P, MatchFilter>>

// ============================================================================
// Route Definition Types
// ============================================================================

/**
 * Props passed to route components
 */
export interface RouteComponentProps<P extends string = string> {
  /** Route parameters */
  params: Params<P>
  /** Current location */
  location: Location
  /** Preloaded data (if preload function is defined) */
  data?: unknown
  /** Children routes rendered via <Outlet /> */
  children?: FictNode
  /** Allow additional properties for component extensibility */
  [key: string]: unknown
}

/**
 * Preload function arguments
 */
export interface PreloadArgs<P extends string = string> {
  /** Route parameters */
  params: Params<P>
  /** Current location */
  location: Location
  /** Navigation intent */
  intent: NavigationIntent
}

/**
 * Preload function type
 */
export type PreloadFunction<T = unknown, P extends string = string> = (
  args: PreloadArgs<P>,
) => T | Promise<T>

/**
 * Route definition - user-facing configuration
 */
export interface RouteDefinition<P extends string = string> {
  /** Path pattern (e.g., "/users/:id", "/items/:id?") */
  path?: string
  /** Component to render for this route */
  component?: Component<RouteComponentProps<P>>
  /** Element to render (alternative to component) */
  element?: FictNode
  /** Preload function for data loading */
  preload?: PreloadFunction<unknown, P>
  /** Nested child routes */
  children?: RouteDefinition[]
  /** Parameter validation filters */
  matchFilters?: MatchFilters<P>
  /** Whether this is an index route */
  index?: boolean
  /** Route key for caching/optimization */
  key?: string
  /** Catch-all error boundary element */
  errorElement?: FictNode
  /** Loading fallback element */
  loadingElement?: FictNode
}

/**
 * Props for the Route component (JSX-based definition)
 */
export interface RouteProps<P extends string = string> extends Omit<
  RouteDefinition<P>,
  'children'
> {
  /** JSX children (nested Route components) */
  children?: FictNode
}

// ============================================================================
// Match Types
// ============================================================================

/**
 * Result of matching a route against a location
 */
export interface RouteMatch<P extends string = string> {
  /** The matched route definition */
  route: RouteDefinition<P>
  /** The matched portion of the pathname */
  pathname: string
  /** Extracted parameters */
  params: Params<P>
  /** The pattern that matched */
  pattern: string
}

/**
 * Internal compiled route with matcher function
 */
export interface CompiledRoute {
  /** Original route definition */
  route: RouteDefinition
  /** Normalized path pattern */
  pattern: string
  /** Matcher function */
  matcher: (pathname: string) => RouteMatch | null
  /** Route score for ranking */
  score: number
  /** Child compiled routes */
  children?: CompiledRoute[]
  /** Unique key for this route */
  key: string
}

/**
 * Branch of routes (for nested route matching)
 */
export interface RouteBranch {
  /** Routes in this branch from root to leaf */
  routes: CompiledRoute[]
  /** Combined score for the branch */
  score: number
  /** Matcher for the entire branch */
  matcher: (pathname: string) => RouteMatch[] | null
}

// ============================================================================
// Navigation Types
// ============================================================================

/**
 * Options for navigation
 */
export interface NavigateOptions {
  /** Replace current history entry instead of pushing */
  replace?: boolean | undefined
  /** State to pass with the navigation */
  state?: unknown
  /** Scroll to top after navigation */
  scroll?: boolean | undefined
  /** Resolve path relative to current route */
  relative?: 'route' | 'path' | undefined
}

/**
 * Navigation function type
 */
export interface NavigateFunction {
  (to: To, options?: NavigateOptions): void
  (delta: number): void
}

/**
 * Navigation state during transitions
 */
export interface Navigation {
  /** Current navigation state */
  state: 'idle' | 'loading' | 'submitting'
  /** Target location (if loading) */
  location?: Location
  /** Form data (if submitting) */
  formData?: FormData
  /** Form action (if submitting) */
  formAction?: string
  /** Form method (if submitting) */
  formMethod?: string
}

// ============================================================================
// Context Types
// ============================================================================

/**
 * Router context value
 */
export interface RouterContextValue {
  /** Current location (reactive) */
  location: () => Location
  /** Route parameters (reactive) */
  params: () => Params
  /** Current matches (reactive) */
  matches: () => RouteMatch[]
  /** Navigate function */
  navigate: NavigateFunction
  /** Whether currently routing */
  isRouting: () => boolean
  /** Pending navigation target (if routing) */
  pendingLocation: () => Location | null
  /** Base path for the router */
  base: string
  /** Resolve a path relative to the current route */
  resolvePath: (to: To) => string
}

/**
 * Route context value (for nested routes)
 */
export interface RouteContextValue {
  /** The current route match */
  match: () => RouteMatch | undefined
  /** Preloaded data */
  data: () => unknown
  /** Route error (if any) */
  error?: () => unknown
  /** Outlet function to render child route */
  outlet: () => FictNode
  /** Parent route context */
  parent?: RouteContextValue
  /** Resolve path relative to this route */
  resolvePath: (to: To) => string
}

// ============================================================================
// History Types
// ============================================================================

/**
 * History action type
 */
export type HistoryAction = 'POP' | 'PUSH' | 'REPLACE'

/**
 * History listener callback
 */
export type HistoryListener = (update: { action: HistoryAction; location: Location }) => void

/**
 * History interface (browser, hash, or memory)
 */
export interface History {
  /** Current action */
  readonly action: HistoryAction
  /** Current location */
  readonly location: Location
  /** Push a new entry */
  push(to: To, state?: unknown): void
  /** Replace the current entry */
  replace(to: To, state?: unknown): void
  /** Go forward or backward */
  go(delta: number): void
  /** Go back one entry */
  back(): void
  /** Go forward one entry */
  forward(): void
  /** Listen for location changes */
  listen(listener: HistoryListener): () => void
  /** Create an href from a To value */
  createHref(to: To): string
  /** Block navigation */
  block(blocker: Blocker): () => void
}

/**
 * Blocker function for preventing navigation
 */
export type Blocker = (tx: { action: HistoryAction; location: Location; retry: () => void }) => void

// ============================================================================
// BeforeLeave Types
// ============================================================================

/**
 * Arguments passed to beforeLeave handlers
 */
export interface BeforeLeaveEventArgs {
  /** Target location */
  to: Location
  /** Current location */
  from: Location
  /** Whether this was prevented */
  defaultPrevented: boolean
  /** Prevent the navigation */
  preventDefault: () => void
  /** Retry the navigation */
  retry: (force?: boolean) => void
}

/**
 * BeforeLeave handler function
 */
export type BeforeLeaveHandler = (e: BeforeLeaveEventArgs) => void | Promise<void>

// ============================================================================
// Data Loading Types
// ============================================================================

/**
 * Submission state
 */
export interface Submission<T = unknown> {
  /** Unique submission key */
  key: string
  /** Form data being submitted */
  formData: FormData
  /** Submission state */
  state: 'submitting' | 'loading' | 'idle'
  /** Result data */
  result?: T
  /** Error if submission failed */
  error?: unknown
  /** Clear the submission */
  clear: () => void
  /** Retry the submission */
  retry: () => void
}

/**
 * Action function type
 */
export type ActionFunction<T = unknown> = (
  formData: FormData,
  args: { params: Params; request: Request },
) => T | Promise<T>

/**
 * Action object returned by createAction
 */
export interface Action<T = unknown> {
  /** Action URL */
  url: string
  /** Submit the action */
  submit: (formData: FormData) => Promise<T>
  /** Action name */
  name?: string
}

/**
 * Query function type
 */
export type QueryFunction<T = unknown, Args extends unknown[] = unknown[]> = (
  ...args: Args
) => T | Promise<T>

/**
 * Query cache entry
 */
export interface QueryCacheEntry<T = unknown> {
  /** Timestamp when cached */
  timestamp: number
  /** Cached promise */
  promise: Promise<T>
  /** Resolved result */
  result?: T
  /** Intent when fetched */
  intent: NavigationIntent
}

// ============================================================================
// Router Configuration Types
// ============================================================================

/**
 * Router configuration options
 */
export interface RouterOptions {
  /** Base path for the router */
  base?: string
  /** Initial location (for SSR) */
  url?: string
  /** History implementation to use */
  history?: History
  /** Data preloaded on server */
  hydrationData?: {
    loaderData?: Record<string, unknown>
    actionData?: Record<string, unknown>
  }
}

/**
 * Memory router options
 */
export interface MemoryRouterOptions extends RouterOptions {
  /** Initial entries in the history stack */
  initialEntries?: string[]
  /** Initial index in the history stack */
  initialIndex?: number
}

/**
 * Hash router options
 */
export interface HashRouterOptions extends RouterOptions {
  /** Hash type: "slash" for /#/path, "noslash" for /#path */
  hashType?: 'slash' | 'noslash'
}
