/**
 * @fileoverview Async data fetching with caching and Suspense support.
 *
 * The `resource` function creates a reactive data fetcher that:
 * - Automatically cancels in-flight requests when args change
 * - Supports Suspense for loading states
 * - Provides caching with TTL and stale-while-revalidate
 * - Handles errors gracefully
 */

import { createEffect, onCleanup, createSuspenseToken } from '@fictjs/runtime'
import { createSignal } from '@fictjs/runtime/advanced'

/**
 * The result of reading a resource.
 *
 * @typeParam T - The type of data returned by the fetcher
 */
export interface ResourceResult<T> {
  /** The fetched data, or undefined if not yet loaded or on error */
  readonly data: T | undefined
  /** Whether the resource is currently loading (initial fetch or refetch) */
  readonly loading: boolean
  /**
   * Any error that occurred during fetching.
   * Type is unknown since errors can be any value in JavaScript.
   */
  readonly error: unknown
  /** Manually trigger a refetch of the resource */
  refresh: () => void
}

/**
 * Cache configuration options for a resource.
 */
export interface ResourceCacheOptions {
  /**
   * Caching mode:
   * - `'memory'`: Cache responses in memory (default)
   * - `'none'`: No caching, always refetch
   * @default 'memory'
   */
  mode?: 'memory' | 'none'

  /**
   * Time-to-live in milliseconds before cached data is considered stale.
   * @default Infinity
   */
  ttlMs?: number

  /**
   * If true, return stale cached data immediately while refetching in background.
   * @default false
   */
  staleWhileRevalidate?: boolean

  /**
   * If true, cache error responses as well.
   * @default false
   */
  cacheErrors?: boolean
}

/**
 * Configuration options for creating a resource.
 *
 * @typeParam T - The type of data returned by the fetcher
 * @typeParam Args - The type of arguments passed to the fetcher
 */
export interface ResourceOptions<T, Args> {
  /**
   * Custom cache key. Can be a static value or a function that computes
   * the key from the args. If not provided, args are used as the key.
   */
  key?: unknown | ((args: Args) => unknown)

  /**
   * The fetcher function that performs the async data retrieval.
   * Receives an AbortController signal for cancellation support.
   */
  fetch: (ctx: { signal: AbortSignal }, args: Args) => Promise<T>

  /**
   * If true, the resource will throw a Suspense token while loading,
   * enabling React-like Suspense boundaries.
   * @default false
   */
  suspense?: boolean

  /**
   * Cache configuration options.
   */
  cache?: ResourceCacheOptions

  /**
   * A value or reactive getter that, when changed, resets the resource.
   * Useful for clearing cache when certain conditions change.
   */
  reset?: unknown | (() => unknown)
}

/**
 * Return type of the resource factory.
 *
 * @typeParam T - The type of data returned by the fetcher
 * @typeParam Args - The type of arguments passed to the fetcher
 */
export interface Resource<T, Args> {
  /**
   * Read the resource data, triggering a fetch if needed.
   * Can accept static args or a reactive getter.
   *
   * @param argsAccessor - Arguments or a getter returning arguments
   */
  read(argsAccessor: (() => Args) | Args): ResourceResult<T>

  /**
   * Invalidate cached data, causing the next read to refetch.
   *
   * @param key - Optional specific key to invalidate. If omitted, invalidates all.
   */
  invalidate(key?: unknown): void

  /**
   * Prefetch data without reading it. Useful for eager loading.
   *
   * @param args - Arguments to pass to the fetcher
   * @param keyOverride - Optional cache key override
   */
  prefetch(args: Args, keyOverride?: unknown): void
}

/**
 * Resource status values for tracking fetch lifecycle.
 * @internal
 */
export type ResourceStatus = 'idle' | 'pending' | 'success' | 'error'

/**
 * Internal cache entry for a resource.
 * Tracks the reactive state and metadata for a single cached fetch.
 *
 * @typeParam T - The type of data returned by the fetcher
 * @typeParam Args - The type of arguments passed to the fetcher
 * @internal
 */
interface ResourceEntry<T, Args> {
  /** Reactive signal for the fetched data */
  data: ReturnType<typeof createSignal<T | undefined>>
  /** Reactive signal for loading state */
  loading: ReturnType<typeof createSignal<boolean>>
  /** Reactive signal for error state */
  error: ReturnType<typeof createSignal<unknown>>
  /** Version counter for invalidation */
  version: ReturnType<typeof createSignal<number>>
  /** Suspense token when using suspense mode */
  pendingToken: ReturnType<typeof createSuspenseToken> | null
  /** Last used arguments for change detection */
  lastArgs: Args | undefined
  /** Last seen version for change detection */
  lastVersion: number
  /** Last reset token value for change detection */
  lastReset: unknown
  /** Whether we have a valid cached value */
  hasValue: boolean
  /** Current fetch status */
  status: ResourceStatus
  /** Generation counter to handle race conditions */
  generation: number
  /** Timestamp when the cached value expires */
  expiresAt: number | undefined
  /** Currently in-flight fetch promise */
  inFlight: Promise<void> | undefined
  /** AbortController for cancelling in-flight requests */
  controller: AbortController | undefined
}

const defaultCacheOptions: Required<ResourceCacheOptions> = {
  mode: 'memory',
  ttlMs: Number.POSITIVE_INFINITY,
  staleWhileRevalidate: false,
  cacheErrors: false,
}

/**
 * Create a reactive async data resource.
 *
 * Resources handle async data fetching with automatic caching, cancellation,
 * and optional Suspense integration.
 *
 * @param optionsOrFetcher - A fetcher function or full configuration object
 * @returns A resource factory with read, invalidate, and prefetch methods
 *
 * @example
 * ```tsx
 * import { resource } from 'fict'
 *
 * // Simple fetcher
 * const userResource = resource(
 *   ({ signal }, userId: string) =>
 *     fetch(`/api/users/${userId}`, { signal }).then(r => r.json())
 * )
 *
 * // With full options
 * const postsResource = resource({
 *   fetch: ({ signal }, userId: string) =>
 *     fetch(`/api/users/${userId}/posts`, { signal }).then(r => r.json()),
 *   suspense: true,
 *   cache: {
 *     ttlMs: 60_000,
 *     staleWhileRevalidate: true,
 *   },
 * })
 *
 * // Usage in component
 * function UserProfile({ userId }: { userId: string }) {
 *   const { data, loading, error, refresh } = userResource.read(() => userId)
 *
 *   if (loading) return <Spinner />
 *   if (error) return <ErrorMessage error={error} />
 *   return <div>{data.name}</div>
 * }
 * ```
 *
 * @public
 */
export function resource<T, Args = void>(
  optionsOrFetcher:
    | ((ctx: { signal: AbortSignal }, args: Args) => Promise<T>)
    | ResourceOptions<T, Args>,
): Resource<T, Args> {
  const fetcher = typeof optionsOrFetcher === 'function' ? optionsOrFetcher : optionsOrFetcher.fetch
  const useSuspense = typeof optionsOrFetcher === 'object' && !!optionsOrFetcher.suspense
  const cacheOptions: ResourceCacheOptions =
    typeof optionsOrFetcher === 'object' ? (optionsOrFetcher.cache ?? {}) : {}
  const resolvedCacheOptions = { ...defaultCacheOptions, ...cacheOptions }
  const cache = new Map<unknown, ResourceEntry<T, Args>>()

  const readArgs = (argsAccessor: (() => Args) | Args): Args =>
    typeof argsAccessor === 'function' ? (argsAccessor as () => Args)() : argsAccessor

  const computeKey = (argsAccessor: (() => Args) | Args): unknown => {
    const argsValue = readArgs(argsAccessor)
    if (typeof optionsOrFetcher === 'object' && optionsOrFetcher.key !== undefined) {
      const key = optionsOrFetcher.key
      return typeof key === 'function' ? (key as (args: Args) => unknown)(argsValue) : key
    }
    return argsValue
  }

  const readResetToken = (): unknown => {
    if (typeof optionsOrFetcher !== 'object') return undefined
    const reset = optionsOrFetcher.reset
    if (typeof reset === 'function' && (reset as () => unknown).length === 0) {
      return (reset as () => unknown)()
    }
    return reset
  }

  const ensureEntry = (key: unknown): ResourceEntry<T, Args> => {
    let state = cache.get(key)
    if (!state) {
      state = {
        data: createSignal<T | undefined>(undefined),
        loading: createSignal<boolean>(false),
        error: createSignal<unknown>(undefined),
        version: createSignal(0),
        pendingToken: null,
        lastArgs: undefined,
        lastVersion: -1,
        lastReset: undefined,
        hasValue: false,
        status: 'idle',
        generation: 0,
        expiresAt: undefined,
        inFlight: undefined,
        controller: undefined,
      }
      cache.set(key, state)
    }
    return state!
  }

  const isExpired = (entry: ResourceEntry<T, Args>): boolean => {
    if (resolvedCacheOptions.mode === 'none') return true
    if (!Number.isFinite(resolvedCacheOptions.ttlMs)) return false
    if (entry.expiresAt === undefined) return false
    return entry.expiresAt < Date.now()
  }

  const markExpiry = (entry: ResourceEntry<T, Args>) => {
    if (resolvedCacheOptions.mode === 'none') {
      entry.expiresAt = Date.now() - 1
      return
    }
    entry.expiresAt = Number.isFinite(resolvedCacheOptions.ttlMs)
      ? Date.now() + resolvedCacheOptions.ttlMs
      : undefined
  }

  const startFetch = (
    entry: ResourceEntry<T, Args>,
    key: unknown,
    args: Args,
    isRevalidating = false,
  ) => {
    entry.controller?.abort()
    entry.inFlight = undefined
    const controller = new AbortController()
    entry.controller = controller
    entry.status = 'pending'
    // For stale-while-revalidate: don't show loading if we already have data to display
    if (!isRevalidating) {
      entry.loading(true)
    }
    entry.error(undefined)
    entry.generation += 1
    const currentGen = entry.generation

    const shouldSuspend = useSuspense && !entry.hasValue
    entry.pendingToken = shouldSuspend ? createSuspenseToken() : null

    const fetchPromise = fetcher({ signal: controller.signal }, args)
      .then(res => {
        if (controller.signal.aborted || entry.generation !== currentGen) return
        entry.data(res)
        entry.hasValue = true
        entry.status = 'success'
        entry.loading(false)
        markExpiry(entry)
        if (entry.pendingToken) {
          entry.pendingToken.resolve()
          entry.pendingToken = null
        }
      })
      .catch(err => {
        if (controller.signal.aborted || entry.generation !== currentGen) return
        entry.error(err)
        entry.status = 'error'
        entry.loading(false)
        if (resolvedCacheOptions.cacheErrors) {
          markExpiry(entry)
        } else {
          entry.expiresAt = Date.now() - 1
          entry.hasValue = false
        }
        if (entry.pendingToken) {
          entry.pendingToken.reject(err)
          entry.pendingToken = null
        }
      })
      .finally(() => {
        entry.inFlight = undefined
        entry.controller = undefined
      })

    entry.inFlight = fetchPromise

    onCleanup(() => {
      if (resolvedCacheOptions.mode === 'none') {
        controller.abort()
        cache.delete(key)
      }
    })
  }

  const invalidate = (key?: unknown) => {
    if (key === undefined) {
      cache.forEach(entry => {
        entry.controller?.abort()
        entry.version(entry.version() + 1)
        entry.expiresAt = Date.now() - 1
      })
      cache.clear()
      return
    }
    const entry = cache.get(key)
    if (entry) {
      entry.controller?.abort()
      entry.version(entry.version() + 1)
      entry.expiresAt = Date.now() - 1
      cache.delete(key)
    }
  }

  const prefetch = (args: Args, keyOverride?: unknown) => {
    const key = keyOverride ?? computeKey(args)
    const entry = ensureEntry(key)
    const usableData = entry.hasValue && !isExpired(entry)
    if (!usableData) {
      entry.lastArgs = args
      entry.lastVersion = entry.version()
      startFetch(entry, key, args)
    }
  }

  return {
    read(argsAccessor: (() => Args) | Args): ResourceResult<T> {
      const entryRef = createSignal<ResourceEntry<T, Args> | null>(null)

      createEffect(() => {
        const key = computeKey(argsAccessor)
        const entry = ensureEntry(key)
        entryRef(entry)
        const args = readArgs(argsAccessor)
        const currentVersion = entry.version()
        const expired = isExpired(entry)
        const argsChanged = entry.lastArgs !== args
        const versionChanged = entry.lastVersion !== currentVersion
        const resetToken = readResetToken()
        const resetChanged = entry.lastReset !== resetToken
        // For stale-while-revalidate: if we have cached data, don't treat expired as requiring immediate refetch
        // We'll handle the revalidation separately to show stale data without loading state
        const canUseStaleData =
          resolvedCacheOptions.staleWhileRevalidate && entry.hasValue && expired
        const shouldRefetch =
          (expired && !canUseStaleData) ||
          argsChanged ||
          versionChanged ||
          resetChanged ||
          (entry.status === 'error' && !resolvedCacheOptions.cacheErrors)

        entry.lastArgs = args
        entry.lastVersion = currentVersion
        entry.lastReset = resetToken

        if (shouldRefetch) {
          if (entry.inFlight && (argsChanged || versionChanged)) {
            entry.controller?.abort()
            entry.inFlight = undefined
          }
          if (resetChanged) {
            entry.hasValue = false
            entry.expiresAt = Date.now() - 1
          }
          startFetch(entry, key, args as Args)
        } else if (canUseStaleData && entry.inFlight === undefined) {
          // stale-while-revalidate: return stale data immediately, refresh in background
          // Pass isRevalidating=true to avoid showing loading state
          startFetch(entry, key, args as Args, true)
        }
      })

      return {
        get data() {
          const entry = entryRef()
          if (!entry) return undefined
          if (useSuspense && entry.pendingToken) {
            throw entry.pendingToken.token
          }
          return entry.data()
        },
        get loading() {
          const entry = entryRef()
          return entry ? entry.loading() : false
        },
        get error() {
          const entry = entryRef()
          return entry ? entry.error() : undefined
        },
        refresh: () => {
          const entry = entryRef()
          if (entry) entry.version(entry.version() + 1)
        },
      }
    },
    invalidate,
    prefetch,
  }
}
