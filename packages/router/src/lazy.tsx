/**
 * @fileoverview Lazy loading utilities for @fictjs/router.
 *
 * Router lazy components use the same internal runtime protocol as
 * `fict/plus`, so preload, reset, retry, and Suspense behavior interoperate.
 */

import { type FictNode, type Component } from '@fictjs/runtime'
import {
  __fictCreateLazyComponent,
  __fictIsLazyComponent,
  __fictPreloadLazyComponent,
} from '@fictjs/runtime/internal'

import type { RouteComponentProps, RouteDefinition } from './types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyComponent = Component<any>

/** Retry behavior shared with `lazy` from `fict/plus`. */
export interface LazyOptions {
  /** Maximum retry attempts after the initial load. Defaults to `0`. */
  maxRetries?: number
  /** Initial exponential-backoff delay in milliseconds. Defaults to `1000`. */
  retryDelay?: number
}

/** A lazy component with explicit preload and retry-reset controls. */
export type LazyComponent<T extends AnyComponent = AnyComponent> = T & {
  reset: () => void
  preload: () => Promise<void>
}

/**
 * Create a lazy-loaded component with Suspense support.
 *
 * Failed loads remain observable until `reset()` is called. `maxRetries` and
 * `retryDelay` can be used for automatic exponential-backoff retries.
 */
export function lazy<T extends AnyComponent>(
  loader: () => Promise<{ default: T } | T>,
  options: LazyOptions = {},
): LazyComponent<T> {
  return __fictCreateLazyComponent(loader, options) as unknown as LazyComponent<T>
}

/** Preload router lazy components, `fict/plus` lazy components, and legacy router lazy values. */
export function preloadLazy(component: AnyComponent): Promise<void> {
  return __fictPreloadLazyComponent(component)
}

/** Check current, framework, and legacy router lazy-component contracts. */
export function isLazyComponent(component: unknown): component is LazyComponent {
  return __fictIsLazyComponent(component)
}

/** Create a lazy route definition. */
export function lazyRoute<P extends string = string>(config: {
  path?: string
  component: () => Promise<
    { default: Component<RouteComponentProps<P>> } | Component<RouteComponentProps<P>>
  >
  loadingElement?: FictNode
  errorElement?: FictNode
  lazyOptions?: LazyOptions | undefined
  preload?: RouteDefinition<P>['preload']
  children?: RouteDefinition[]
  index?: boolean
  key?: string
}): RouteDefinition<P> {
  const LazyRouteComponent = lazy(config.component, config.lazyOptions)
  const routeDefinition: RouteDefinition<P> = {
    component: LazyRouteComponent as Component<RouteComponentProps<P>>,
  }

  if (config.path !== undefined) routeDefinition.path = config.path
  if (config.loadingElement !== undefined) routeDefinition.loadingElement = config.loadingElement
  if (config.errorElement !== undefined) routeDefinition.errorElement = config.errorElement
  if (config.preload !== undefined) routeDefinition.preload = config.preload
  if (config.children !== undefined) routeDefinition.children = config.children
  if (config.index !== undefined) routeDefinition.index = config.index
  if (config.key !== undefined) routeDefinition.key = config.key

  return routeDefinition
}

/** Create lazy route definitions from a glob-import module map. */
export function createLazyRoutes(
  modules: Record<string, () => Promise<{ default: AnyComponent }>>,
  options: {
    pathTransform?: (filePath: string) => string
    loadingElement?: FictNode
    errorElement?: FictNode
    lazyOptions?: LazyOptions
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
        lazyOptions: options.lazyOptions,
      }),
    )
  }

  return routes
}
