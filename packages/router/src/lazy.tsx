/**
 * @fileoverview Lazy loading utilities for @fictjs/router
 *
 * This module provides code splitting support via lazy loading of route components.
 * Works with Fict's Suspense for loading states.
 */

import { type FictNode, type Component } from '@fictjs/runtime'
import { createSignal } from '@fictjs/runtime/advanced'

import type { RouteComponentProps, RouteDefinition } from './types'

// ============================================================================
// Lazy Component
// ============================================================================

/**
 * State for lazy-loaded component
 */
interface LazyState<T> {
  component: T | null
  error: unknown
  loading: boolean
}

/**
 * Create a lazy-loaded component
 *
 * @example
 * ```tsx
 * // Create a lazy component
 * const LazyUserProfile = lazy(() => import('./pages/UserProfile'))
 *
 * // Use in routes
 * <Route path="/users/:id" component={LazyUserProfile} />
 *
 * // Or with Suspense fallback
 * <Suspense fallback={<Loading />}>
 *   <LazyUserProfile />
 * </Suspense>
 * ```
 */
export function lazy<T extends Component<any>>(
  loader: () => Promise<{ default: T } | T>,
): Component<any> {
  let cachedComponent: T | null = null
  let loadPromise: Promise<T> | null = null

  // Create a wrapper component that handles lazy loading
  const LazyComponent: Component<any> = props => {
    const state = createSignal<LazyState<T>>({
      component: cachedComponent,
      error: null,
      loading: !cachedComponent,
    })

    // If already cached, render immediately
    if (cachedComponent) {
      const CachedComponent = cachedComponent
      return <CachedComponent {...props} />
    }

    // Start loading if not already in progress
    if (!loadPromise) {
      loadPromise = loader().then(module => {
        // Handle both { default: Component } and direct Component exports
        const component = 'default' in module ? module.default : module
        cachedComponent = component
        return component
      })
    }

    // Load the component
    loadPromise
      .then(component => {
        state({ component, error: null, loading: false })
      })
      .catch(error => {
        state({ component: null, error, loading: false })
      })

    // Render based on state
    const currentState = state()

    if (currentState.error) {
      throw currentState.error
    }

    if (currentState.loading || !currentState.component) {
      // Return null while loading - Suspense will handle the fallback
      // For this to work properly with Suspense, we need to throw a promise
      throw loadPromise
    }

    const LoadedComponent = currentState.component
    return <LoadedComponent {...props} />
  }

  // Mark as lazy for identification
  ;(LazyComponent as any).__lazy = true
  ;(LazyComponent as any).__preload = () => {
    if (!loadPromise) {
      loadPromise = loader().then(module => {
        const component = 'default' in module ? module.default : module
        cachedComponent = component
        return component
      })
    }
    return loadPromise
  }

  return LazyComponent
}

/**
 * Preload a lazy component
 * Useful for preloading on hover/focus
 */
export function preloadLazy(component: Component<any>): Promise<void> {
  const lazyComp = component as any
  if (lazyComp.__lazy && lazyComp.__preload) {
    return lazyComp.__preload()
  }
  return Promise.resolve()
}

/**
 * Check if a component is a lazy component
 */
export function isLazyComponent(component: unknown): boolean {
  return !!(component && typeof component === 'function' && (component as any).__lazy)
}

// ============================================================================
// Lazy Route
// ============================================================================

/**
 * Create a lazy route definition
 *
 * @example
 * ```tsx
 * const routes = [
 *   lazyRoute({
 *     path: '/users/:id',
 *     component: () => import('./pages/UserProfile'),
 *   }),
 *   lazyRoute({
 *     path: '/settings',
 *     component: () => import('./pages/Settings'),
 *     loadingElement: <Loading />,
 *     errorElement: <Error />,
 *   }),
 * ]
 * ```
 */
export function lazyRoute<P extends string = string>(config: {
  path?: string
  component: () => Promise<
    { default: Component<RouteComponentProps<P>> } | Component<RouteComponentProps<P>>
  >
  loadingElement?: FictNode
  errorElement?: FictNode
  preload?: RouteDefinition<P>['preload']
  children?: RouteDefinition[]
  index?: boolean
  key?: string
}): RouteDefinition<P> {
  const LazyComponent = lazy(config.component)

  // Build the route definition, only including defined properties
  const routeDef: RouteDefinition<P> = {
    component: LazyComponent as Component<RouteComponentProps<P>>,
  }

  if (config.path !== undefined) routeDef.path = config.path
  if (config.loadingElement !== undefined) routeDef.loadingElement = config.loadingElement
  if (config.errorElement !== undefined) routeDef.errorElement = config.errorElement
  if (config.preload !== undefined) routeDef.preload = config.preload
  if (config.children !== undefined) routeDef.children = config.children
  if (config.index !== undefined) routeDef.index = config.index
  if (config.key !== undefined) routeDef.key = config.key

  return routeDef
}

// ============================================================================
// Lazy Loading Helpers
// ============================================================================

/**
 * Create multiple lazy routes from a glob import pattern
 * Useful for file-system based routing
 *
 * @example
 * ```tsx
 * // In a Vite project
 * const pages = import.meta.glob('./pages/*.tsx')
 *
 * const routes = createLazyRoutes(pages, {
 *   // Map file path to route path
 *   pathTransform: (filePath) => {
 *     // ./pages/UserProfile.tsx -> /user-profile
 *     return filePath
 *       .replace('./pages/', '/')
 *       .replace('.tsx', '')
 *       .toLowerCase()
 *       .replace(/([A-Z])/g, '-$1')
 *   },
 * })
 * ```
 */
export function createLazyRoutes(
  modules: Record<string, () => Promise<{ default: Component<any> }>>,
  options: {
    pathTransform?: (filePath: string) => string
    loadingElement?: FictNode
    errorElement?: FictNode
  } = {},
): RouteDefinition[] {
  const routes: RouteDefinition[] = []

  for (const [filePath, loader] of Object.entries(modules)) {
    const path = options.pathTransform
      ? options.pathTransform(filePath)
      : filePath
          .replace(/^\.\/pages/, '')
          .replace(/\.(tsx?|jsx?)$/, '')
          .toLowerCase()

    routes.push(
      lazyRoute({
        path,
        component: loader,
        loadingElement: options.loadingElement,
        errorElement: options.errorElement,
      }),
    )
  }

  return routes
}
