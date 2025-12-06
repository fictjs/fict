import { createSuspenseToken } from 'fict-runtime'
import type { Component } from 'fict-runtime'

export interface LazyModule<TProps extends Record<string, unknown>> {
  default: Component<TProps>
}

/**
 * Create a lazy component that suspends while loading.
 */
export function lazy<TProps extends Record<string, unknown> = Record<string, unknown>>(
  loader: () => Promise<LazyModule<TProps> | { default: Component<TProps> }>,
): Component<TProps> {
  let loaded: Component<TProps> | null = null
  let loadError: unknown = null
  let loadingPromise: Promise<unknown> | null = null
  let pendingToken: ReturnType<typeof createSuspenseToken> | null = null

  return props => {
    if (loaded) {
      return loaded(props)
    }
    if (loadError) {
      throw loadError
    }
    if (!loadingPromise) {
      pendingToken = createSuspenseToken()
      loadingPromise = loader()
        .then(mod => {
          loaded = (mod as LazyModule<TProps>).default
          pendingToken?.resolve()
        })
        .catch(err => {
          loadError = err
          pendingToken?.reject(err)
        })
        .finally(() => {
          loadingPromise = null
          pendingToken = null
        })
    }
    if (pendingToken) {
      throw pendingToken.token
    }
    // Should never hit if pendingToken exists, but fallback for type safety.
    throw new Error('Lazy component failed to start loading')
  }
}
