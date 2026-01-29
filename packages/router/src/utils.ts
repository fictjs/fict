/**
 * @fileoverview Path matching and utility functions for @fictjs/router
 *
 * This module provides path parsing, matching, and scoring utilities.
 * Based on patterns from Solid Router with optimizations for Fict.
 */

import type {
  Location,
  To,
  Params,
  RouteMatch,
  RouteDefinition,
  CompiledRoute,
  RouteBranch,
  MatchFilter,
} from './types'

// ============================================================================
// Path Normalization
// ============================================================================

/**
 * Normalize a path by removing trailing slashes and ensuring leading slash
 */
export function normalizePath(path: string): string {
  // Handle empty or root path
  if (!path || path === '/') return '/'

  // Ensure leading slash
  let normalized = path.startsWith('/') ? path : '/' + path

  // Remove trailing slash (except for root)
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1)
  }

  return normalized
}

/**
 * Join path segments together
 */
export function joinPaths(...paths: (string | undefined)[]): string {
  return normalizePath(
    paths
      .filter((p): p is string => p != null && p !== '')
      .join('/')
      .replace(/\/+/g, '/'),
  )
}

/**
 * Resolve a relative path against a base path
 */
export function resolvePath(base: string, to: To): string {
  const toPath = typeof to === 'string' ? to : to.pathname || ''

  // Absolute path
  if (toPath.startsWith('/')) {
    return normalizePath(toPath)
  }

  // Relative path resolution
  const baseSegments = base.split('/').filter(Boolean)

  // Handle special relative segments
  const toSegments = toPath.split('/').filter(Boolean)

  for (const segment of toSegments) {
    if (segment === '..') {
      baseSegments.pop()
    } else if (segment !== '.') {
      baseSegments.push(segment)
    }
  }

  return '/' + baseSegments.join('/')
}

// ============================================================================
// Location Utilities
// ============================================================================

/**
 * Create a Location object from a To value
 */
export function createLocation(to: To, state?: unknown, key?: string): Location {
  if (typeof to === 'string') {
    const url = parseURL(to)
    return {
      pathname: url.pathname,
      search: url.search,
      hash: url.hash,
      state: state ?? null,
      key: key ?? createKey(),
    }
  }

  return {
    pathname: to.pathname || '/',
    search: to.search || '',
    hash: to.hash || '',
    state: state ?? to.state ?? null,
    key: key ?? to.key ?? createKey(),
  }
}

/**
 * Parse a URL string into its components
 */
export function parseURL(url: string): { pathname: string; search: string; hash: string } {
  // Handle hash first
  const hashIndex = url.indexOf('#')
  let hash = ''
  if (hashIndex >= 0) {
    hash = url.slice(hashIndex)
    url = url.slice(0, hashIndex)
  }

  // Handle search
  const searchIndex = url.indexOf('?')
  let search = ''
  if (searchIndex >= 0) {
    search = url.slice(searchIndex)
    url = url.slice(0, searchIndex)
  }

  return {
    pathname: normalizePath(url || '/'),
    search,
    hash,
  }
}

/**
 * Create a URL string from a Location object
 */
export function createURL(location: Partial<Location>): string {
  const pathname = location.pathname || '/'
  const search = location.search || ''
  const hash = location.hash || ''
  return pathname + search + hash
}

/**
 * Generate a unique key for location entries
 */
let keyIndex = 0
export function createKey(): string {
  return String(++keyIndex)
}

// ============================================================================
// Path Matching
// ============================================================================

/**
 * Segment types for pattern matching
 */
type SegmentType = 'static' | 'dynamic' | 'optional' | 'splat'

interface PathSegment {
  type: SegmentType
  value: string
  paramName?: string
}

/**
 * Parse a path pattern into segments
 */
export function parsePathPattern(pattern: string): PathSegment[] {
  const segments: PathSegment[] = []
  const parts = pattern.split('/').filter(Boolean)

  for (const part of parts) {
    if (part === '*' || part.startsWith('*')) {
      // Splat/catch-all segment
      const paramName = part.length > 1 ? part.slice(1) : '*'
      segments.push({ type: 'splat', value: part, paramName })
    } else if (part.startsWith(':')) {
      // Dynamic or optional segment
      const isOptional = part.endsWith('?')
      const paramName = isOptional ? part.slice(1, -1) : part.slice(1)
      segments.push({
        type: isOptional ? 'optional' : 'dynamic',
        value: part,
        paramName,
      })
    } else {
      // Static segment
      segments.push({ type: 'static', value: part.toLowerCase() })
    }
  }

  return segments
}

/**
 * Calculate the score for a route pattern.
 * Higher score = more specific route.
 *
 * Scoring:
 * - Static segment: 3 points
 * - Dynamic segment: 2 points
 * - Optional segment: 1 point
 * - Splat segment: 0.5 points
 * - Index route bonus: 0.5 points
 */
export function scoreRoute(pattern: string, isIndex = false): number {
  const segments = parsePathPattern(pattern)
  let score = 0

  for (const segment of segments) {
    switch (segment.type) {
      case 'static':
        score += 3
        break
      case 'dynamic':
        score += 2
        break
      case 'optional':
        score += 1
        break
      case 'splat':
        score += 0.5
        break
    }
  }

  // Index route gets a small bonus
  if (isIndex) {
    score += 0.5
  }

  return score
}

/**
 * Create a matcher function for a path pattern
 */
export function createMatcher(
  pattern: string,
  matchFilters?: Record<string, MatchFilter>,
): (pathname: string) => RouteMatch | null {
  const segments = parsePathPattern(pattern)
  const normalizedPattern = normalizePath(pattern)

  return (pathname: string): RouteMatch | null => {
    const pathSegments = pathname.split('/').filter(Boolean)
    const params: Record<string, string> = {}
    let matchedPath = ''
    let pathIndex = 0

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]!
      const pathSegment = pathSegments[pathIndex]

      switch (segment.type) {
        case 'static':
          // Must match exactly (case-insensitive)
          if (!pathSegment || pathSegment.toLowerCase() !== segment.value) {
            return null
          }
          matchedPath += '/' + pathSegment
          pathIndex++
          break

        case 'dynamic':
          // Must have a value
          if (!pathSegment) {
            return null
          }
          // Validate with filter if provided
          if (matchFilters && segment.paramName && matchFilters[segment.paramName]) {
            if (!validateParam(pathSegment, matchFilters[segment.paramName]!)) {
              return null
            }
          }
          params[segment.paramName!] = decodeURIComponent(pathSegment)
          matchedPath += '/' + pathSegment
          pathIndex++
          break

        case 'optional': {
          // May or may not have a value
          if (pathSegment) {
            // Look ahead: if next pattern segment is static and matches current path segment,
            // skip this optional to allow the static to match
            const nextSegment = segments[i + 1]
            if (
              nextSegment &&
              nextSegment.type === 'static' &&
              pathSegment.toLowerCase() === nextSegment.value
            ) {
              // Skip this optional - don't consume the path segment
              // so the next iteration can match it as static
              break
            }

            // Validate with filter if provided
            if (matchFilters && segment.paramName && matchFilters[segment.paramName]) {
              if (!validateParam(pathSegment, matchFilters[segment.paramName]!)) {
                // Optional segment doesn't match filter, treat as not provided
                break
              }
            }
            params[segment.paramName!] = decodeURIComponent(pathSegment)
            matchedPath += '/' + pathSegment
            pathIndex++
          }
          break
        }

        case 'splat': {
          // Capture remaining path
          // Decode each segment individually to handle encoded slashes correctly
          const remainingSegments = pathSegments.slice(pathIndex)
          const decodedSegments = remainingSegments.map(seg => {
            try {
              return decodeURIComponent(seg)
            } catch {
              // If decoding fails (malformed URI), use the original segment
              return seg
            }
          })
          params[segment.paramName!] = decodedSegments.join('/')
          matchedPath += remainingSegments.length > 0 ? '/' + remainingSegments.join('/') : ''
          pathIndex = pathSegments.length
          break
        }
      }
    }

    // If we haven't consumed all path segments, this is not a match
    // (unless the last segment was a splat)
    if (pathIndex < pathSegments.length) {
      return null
    }

    return {
      route: {} as RouteDefinition, // Will be filled in by caller
      pathname: matchedPath || '/',
      params: params as Params,
      pattern: normalizedPattern,
    }
  }
}

/**
 * Validate a parameter value against a filter
 */
function validateParam(value: string, filter: MatchFilter): boolean {
  if (filter instanceof RegExp) {
    return filter.test(value)
  }
  if (Array.isArray(filter)) {
    return filter.includes(value)
  }
  if (typeof filter === 'function') {
    return filter(value)
  }
  return true
}

// ============================================================================
// Route Compilation
// ============================================================================

let routeKeyCounter = 0

/**
 * Compile a route definition into a CompiledRoute
 */
export function compileRoute(route: RouteDefinition, parentPattern = ''): CompiledRoute {
  const pattern = normalizePath(
    joinPaths(parentPattern, route.path || (route.index ? '' : undefined)),
  )

  const compiled: CompiledRoute = {
    route,
    pattern,
    matcher: createMatcher(pattern, route.matchFilters as Record<string, MatchFilter>),
    score: scoreRoute(pattern, route.index),
    key: route.key || `route-${++routeKeyCounter}`,
  }

  if (route.children && route.children.length > 0) {
    compiled.children = route.children.map(child =>
      compileRoute(child, route.index ? parentPattern : pattern),
    )
  }

  return compiled
}

/**
 * Create branches from compiled routes for efficient matching.
 * A branch represents a complete path from root to leaf.
 */
export function createBranches(routes: CompiledRoute[]): RouteBranch[] {
  const branches: RouteBranch[] = []

  function buildBranches(route: CompiledRoute, parentRoutes: CompiledRoute[] = []): void {
    const currentRoutes = [...parentRoutes, route]

    if (route.children && route.children.length > 0) {
      for (const child of route.children) {
        buildBranches(child, currentRoutes)
      }
    } else {
      // Leaf route - create a branch
      const score = currentRoutes.reduce((sum, r) => sum + r.score, 0)

      const branchMatcher = (pathname: string): RouteMatch[] | null => {
        const matches: RouteMatch[] = []
        let remainingPath = pathname
        let accumulatedParams: Record<string, string | undefined> = {}

        for (const compiledRoute of currentRoutes) {
          const match = compiledRoute.matcher(remainingPath)
          if (!match) {
            return null
          }

          // Accumulate params
          accumulatedParams = { ...accumulatedParams, ...match.params }

          matches.push({
            ...match,
            route: compiledRoute.route,
            params: { ...accumulatedParams } as Params,
          })

          // For nested routes, the remaining path should be after the matched portion
          // But only if this isn't the leaf route
          if (compiledRoute !== currentRoutes[currentRoutes.length - 1]) {
            if (match.pathname !== '/') {
              remainingPath = remainingPath.slice(match.pathname.length) || '/'
            }
          }
        }

        return matches
      }

      branches.push({
        routes: currentRoutes,
        score,
        matcher: branchMatcher,
      })
    }
  }

  for (const route of routes) {
    buildBranches(route)
  }

  // Sort branches by score (highest first)
  branches.sort((a, b) => b.score - a.score)

  return branches
}

/**
 * Match a pathname against route branches
 */
export function matchRoutes(branches: RouteBranch[], pathname: string): RouteMatch[] | null {
  const normalizedPath = normalizePath(pathname)

  for (const branch of branches) {
    const matches = branch.matcher(normalizedPath)
    if (matches) {
      return matches
    }
  }

  return null
}

// ============================================================================
// Search Params Utilities
// ============================================================================

/**
 * Parse search params from a search string
 */
export function parseSearchParams(search: string): URLSearchParams {
  return new URLSearchParams(search)
}

/**
 * Stringify search params to a search string
 */
export function stringifySearchParams(params: URLSearchParams | Record<string, string>): string {
  const searchParams = params instanceof URLSearchParams ? params : new URLSearchParams(params)

  const str = searchParams.toString()
  return str ? '?' + str : ''
}

// ============================================================================
// Misc Utilities
// ============================================================================

/**
 * Check if two locations are equal
 */
export function locationsAreEqual(a: Location, b: Location): boolean {
  return a.pathname === b.pathname && a.search === b.search && a.hash === b.hash
}

/**
 * Strip the base path from a pathname
 */
export function stripBasePath(pathname: string, basePath: string): string {
  if (basePath === '/' || basePath === '') {
    return pathname
  }

  const normalizedBase = normalizePath(basePath)
  if (pathname.startsWith(normalizedBase)) {
    const stripped = pathname.slice(normalizedBase.length)
    return stripped || '/'
  }

  return pathname
}

/**
 * Prepend the base path to a pathname
 */
export function prependBasePath(pathname: string, basePath: string): string {
  if (basePath === '/' || basePath === '') {
    return pathname
  }

  return joinPaths(basePath, pathname)
}

/**
 * Generate a stable hash for route params (for caching)
 */
export function hashParams(params: Record<string, unknown>): string {
  const entries = Object.entries(params).sort(([a], [b]) => a.localeCompare(b))
  return JSON.stringify(entries)
}

/**
 * Scroll to top of the page
 */
export function scrollToTop(): void {
  if (typeof window !== 'undefined') {
    window.scrollTo(0, 0)
  }
}

/**
 * Check if code is running on the server
 */
export function isServer(): boolean {
  return typeof window === 'undefined'
}

/**
 * Check if code is running in the browser
 */
export function isBrowser(): boolean {
  return typeof window !== 'undefined'
}
