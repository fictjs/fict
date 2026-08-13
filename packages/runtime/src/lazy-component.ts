import { createSuspenseToken } from './suspense'
import type { Component, FictNode } from './types'

/** Shared lazy-component options used by first-party packages. */
export interface FictLazyOptions {
  /** Maximum retry attempts after the initial load. */
  maxRetries?: number
  /** Initial exponential-backoff delay in milliseconds. */
  retryDelay?: number
}

/** A module or direct component accepted by the shared lazy loader. */
export type FictLazyLoadResult<TProps extends Record<string, unknown>> =
  | { default: Component<TProps> }
  | Component<TProps>

/** Common structural contract for a Fict lazy component. */
export interface FictLazyComponent<
  TProps extends Record<string, unknown>,
> extends Component<TProps> {
  reset: () => void
  preload: () => Promise<void>
  /** @internal Legacy router marker retained for cross-version interoperability. */
  readonly __lazy: true
  /** @internal Legacy router preloader retained for cross-version interoperability. */
  readonly __preload: () => Promise<void>
}

const LAZY_COMPONENT_MARKER = Symbol.for('fict.lazy-component')

interface LazyCandidate {
  [LAZY_COMPONENT_MARKER]?: boolean
  __lazy?: boolean
  __preload?: () => unknown
  preload?: () => unknown
  reset?: () => void
}

function resolveLazyComponent<TProps extends Record<string, unknown>>(
  loaded: FictLazyLoadResult<TProps>,
): Component<TProps> {
  const component =
    typeof loaded === 'function'
      ? loaded
      : (loaded as { default?: Component<TProps> } | null | undefined)?.default
  if (typeof component !== 'function') {
    throw new TypeError(
      '[fict] lazy() loader must resolve to a component or a module with a default component.',
    )
  }
  return component
}

/** @internal Create the lazy implementation shared by `fict/plus` and the router. */
export function __fictCreateLazyComponent<
  TProps extends Record<string, unknown> = Record<string, unknown>,
>(
  loader: () => Promise<FictLazyLoadResult<TProps>>,
  options: FictLazyOptions = {},
): FictLazyComponent<TProps> {
  const { maxRetries = 0, retryDelay = 1000 } = options

  let loaded: Component<TProps> | null = null
  let loadError: unknown = null
  let hasLoadError = false
  let loadingPromise: Promise<void> | null = null
  let pendingToken: ReturnType<typeof createSuspenseToken> | null = null
  let retryCount = 0
  let loadGeneration = 0

  const isCurrentLoad = (generation: number): boolean => generation === loadGeneration

  const attemptLoad = (generation: number): Promise<void> => {
    let loadedModule: Promise<FictLazyLoadResult<TProps>>
    try {
      loadedModule = Promise.resolve(loader())
    } catch (error) {
      loadedModule = Promise.reject(error)
    }

    return loadedModule
      .then(module => {
        if (!isCurrentLoad(generation)) return
        loaded = resolveLazyComponent(module)
        loadError = null
        hasLoadError = false
        retryCount = 0
        pendingToken?.resolve()
      })
      .catch((error: unknown) => {
        if (!isCurrentLoad(generation)) throw error
        if (retryCount < maxRetries) {
          retryCount++
          const delay = retryDelay * Math.pow(2, retryCount - 1)
          return new Promise<void>((resolve, reject) => {
            setTimeout(() => {
              if (!isCurrentLoad(generation)) {
                resolve()
                return
              }
              attemptLoad(generation).then(resolve, reject)
            }, delay)
          })
        }
        if (!isCurrentLoad(generation)) throw error
        loadError = error
        hasLoadError = true
        pendingToken?.reject(error)
        throw error
      })
      .finally(() => {
        if (isCurrentLoad(generation)) {
          loadingPromise = null
          pendingToken = null
        }
      })
  }

  const startLoad = (): Promise<void> => {
    const generation = ++loadGeneration
    loadingPromise = attemptLoad(generation)
    void loadingPromise.catch(() => {
      // Render-driven loads are observed through the Suspense token. The
      // public preload promise intentionally remains rejected for callers.
    })
    return loadingPromise
  }

  const component = ((props: TProps) => {
    if (loaded) {
      // Preserve the resolved function as a real component boundary. Calling
      // it directly would bypass hook/devtools ownership and resumable
      // component metadata registered on the loaded export.
      return {
        type: loaded as unknown as (props: Record<string, unknown>) => FictNode,
        props,
      }
    }
    if (hasLoadError) throw loadError
    pendingToken ??= createSuspenseToken()
    if (!loadingPromise) startLoad()
    throw pendingToken.token
  }) as FictLazyComponent<TProps>

  const reset = () => {
    loadGeneration++
    const suspendedToken = pendingToken
    loadError = null
    hasLoadError = false
    loadingPromise = null
    pendingToken = null
    retryCount = 0
    suspendedToken?.resolve()
  }

  const preload = (): Promise<void> => {
    if (loaded) return Promise.resolve()
    if (hasLoadError) return Promise.reject(loadError)
    if (loadingPromise) return loadingPromise
    return startLoad()
  }

  Object.defineProperties(component, {
    reset: { value: reset, writable: true, enumerable: true, configurable: true },
    preload: { value: preload, writable: true, enumerable: true, configurable: true },
    __lazy: { value: true, writable: true, enumerable: true, configurable: true },
    __preload: { value: preload, writable: true, enumerable: true, configurable: true },
    [LAZY_COMPONENT_MARKER]: { value: true },
  })

  return component
}

/** @internal Recognize current and legacy Fict lazy-component contracts. */
export function __fictIsLazyComponent(
  component: unknown,
): component is FictLazyComponent<Record<string, unknown>> {
  if (typeof component !== 'function') return false
  try {
    const candidate = component as LazyCandidate
    const preload = candidate.preload
    const reset = candidate.reset
    return (
      candidate[LAZY_COMPONENT_MARKER] === true ||
      candidate.__lazy === true ||
      (typeof preload === 'function' && typeof reset === 'function')
    )
  } catch {
    return false
  }
}

/** @internal Preload current framework lazy components and legacy router ones. */
export function __fictPreloadLazyComponent(component: unknown): Promise<void> {
  if (typeof component !== 'function') return Promise.resolve()
  try {
    const candidate = component as LazyCandidate
    const preload = candidate.preload
    const reset = candidate.reset
    const legacyPreload = candidate.__preload
    const hasPublicProtocol = typeof preload === 'function' && typeof reset === 'function'
    const hasSharedMarker = candidate[LAZY_COMPONENT_MARKER] === true
    if (
      (hasSharedMarker || hasPublicProtocol || candidate.__lazy === true) &&
      typeof preload === 'function'
    ) {
      return Promise.resolve(preload.call(component)).then(() => undefined)
    }
    if (candidate.__lazy === true && typeof legacyPreload === 'function') {
      return Promise.resolve(legacyPreload.call(component)).then(() => undefined)
    }
    return Promise.resolve()
  } catch (error) {
    return Promise.reject(error)
  }
}
