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
import { createSignal, isReactive } from '@fictjs/runtime/advanced'
import { __fictGetCurrentSSRSession, __fictIsSSRSessionActive } from '@fictjs/runtime/internal'

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
   * Memory-cache scope during server-side rendering:
   * - `'request'`: Isolate entries to the active SSR request (default)
   * - `'shared'`: Share entries across SSR requests for explicitly public data
   *
   * In the browser, memory caching remains scoped to the resource instance.
   * @default 'request'
   */
  scope?: 'request' | 'shared'

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

  /**
   * Maximum number of cached entries. Least-recently-used entries beyond
   * this bound are evicted (in-flight entries are never evicted).
   * @default 256
   */
  maxEntries?: number
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
   * A value or explicitly marked reactive getter that, when changed, resets the resource.
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
   * Can accept static args or an explicitly marked reactive getter.
   *
   * @param argsAccessor - Arguments or an explicitly marked getter returning arguments
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

  /**
   * Optimistically update cached data for a given args/key.
   *
   * @param argsAccessor - Arguments or an explicitly marked getter returning arguments
   * @param value - New value or updater function
   * @param options - Optional settings (key override, revalidate)
   */
  mutate(
    argsAccessor: (() => Args) | Args,
    value: T | ((prev: T | undefined) => T),
    options?: { key?: unknown; revalidate?: boolean },
  ): void
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
  /** Args used for the current in-flight request */
  inFlightArgs: Args | undefined
  /** AbortController for cancelling in-flight requests */
  controller: AbortController | undefined
}

const defaultCacheOptions: Required<ResourceCacheOptions> = {
  mode: 'memory',
  scope: 'request',
  ttlMs: Number.POSITIVE_INFINITY,
  staleWhileRevalidate: false,
  cacheErrors: false,
  maxEntries: 256,
}

const STRUCTURAL_KEY_PREFIX = '\u0000fict:args:'

/**
 * Deterministic serialization for plain-data args (sorted object keys).
 * Throws on cycles and non-plain objects so the caller can fall back to
 * identity keying.
 */
function stableStringify(value: unknown, seen: WeakSet<object>): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (typeof value === 'boolean') return value ? 'boolean:true' : 'boolean:false'
  if (typeof value === 'string') return `string:${JSON.stringify(value)}`
  if (typeof value === 'bigint') return `bigint:${value.toString()}`
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'number:NaN'
    if (Object.is(value, -0)) return 'number:-0'
    if (value === Number.POSITIVE_INFINITY) return 'number:+Infinity'
    if (value === Number.NEGATIVE_INFINITY) return 'number:-Infinity'
    return `number:${String(value)}`
  }
  if (typeof value !== 'object') {
    throw new Error('non-serializable')
  }
  if (seen.has(value)) throw new Error('cyclic')
  seen.add(value)
  try {
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new Error('non-serializable')
    }
    if (Array.isArray(value)) {
      const arrayKeys = Object.keys(value)
      if (
        arrayKeys.some(key => {
          const index = Number(key)
          return (
            !Number.isInteger(index) || index < 0 || index >= value.length || String(index) !== key
          )
        })
      ) {
        throw new Error('non-serializable')
      }
      const items: string[] = []
      for (let i = 0; i < value.length; i++) {
        items.push(
          Object.prototype.hasOwnProperty.call(value, i)
            ? stableStringify(value[i], seen)
            : 'array-hole',
        )
      }
      return `array:[${items.join(',')}]`
    }
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) throw new Error('non-plain')
    const keys = Object.keys(value).sort()
    return (
      (proto === null ? 'null-object:{' : 'object:{') +
      keys
        .map(
          key =>
            JSON.stringify(key) +
            ':' +
            stableStringify((value as Record<string, unknown>)[key], seen),
        )
        .join(',') +
      '}'
    )
  } finally {
    seen.delete(value)
  }
}

/**
 * Derive a stable cache key for default (key-less) resources. Plain data
 * objects with equal contents share a key, so fresh `{ id }` literals hit
 * the cache instead of growing it; non-plain or cyclic args fall back to
 * identity keying.
 */
function structuralArgsKey(argsValue: unknown): unknown {
  try {
    return STRUCTURAL_KEY_PREFIX + stableStringify(argsValue, new WeakSet())
  } catch {
    return argsValue
  }
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
 * import { reactive } from 'fict/advanced'
 * import { resource } from 'fict/plus'
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
 *   const { data, loading, error, refresh } = userResource.read(reactive(() => userId))
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
  type Cache = Map<unknown, ResourceEntry<T, Args>>
  type SSRSession = NonNullable<ReturnType<typeof __fictGetCurrentSSRSession>>

  const sharedCache: Cache = new Map()
  const requestCaches = new WeakMap<SSRSession, Cache>()

  const resolveCache = (): Cache => {
    const session = __fictGetCurrentSSRSession()
    if (resolvedCacheOptions.scope === 'shared') {
      return sharedCache
    }

    if (!session) {
      // An active SSR render without a visible session means its async carrier
      // was lost or is unavailable (for example in an edge fallback). Never
      // fall back to process-wide memory for the default request scope.
      return __fictIsSSRSessionActive() ? new Map() : sharedCache
    }

    let requestCache = requestCaches.get(session)
    if (!requestCache) {
      requestCache = new Map()
      requestCaches.set(session, requestCache)
    }
    return requestCache
  }

  const readArgs = (argsAccessor: (() => Args) | Args): Args =>
    isReactive(argsAccessor) ? (argsAccessor as () => Args)() : (argsAccessor as Args)

  const hasCustomKey = typeof optionsOrFetcher === 'object' && optionsOrFetcher.key !== undefined

  const computeKey = (argsAccessor: (() => Args) | Args): unknown => {
    const argsValue = readArgs(argsAccessor)
    if (hasCustomKey) {
      const key = (optionsOrFetcher as ResourceOptions<T, Args>).key
      return structuralArgsKey(
        typeof key === 'function' ? (key as (args: Args) => unknown)(argsValue) : key,
      )
    }
    return structuralArgsKey(argsValue)
  }

  const readResetToken = (): unknown => {
    if (typeof optionsOrFetcher !== 'object') return undefined
    const reset = optionsOrFetcher.reset
    if (isReactive(reset)) {
      return (reset as () => unknown)()
    }
    return reset
  }

  const evictOverflowEntries = (cache: Cache, protectedEntry?: ResourceEntry<T, Args>) => {
    const maxEntries = resolvedCacheOptions.maxEntries
    if (!Number.isFinite(maxEntries) || maxEntries <= 0) return
    if (cache.size <= maxEntries) return
    for (const [entryKey, entry] of cache) {
      if (cache.size <= maxEntries) break
      // Never evict entries with work in progress.
      if (entry === protectedEntry || entry.inFlight || entry.pendingToken) continue
      cache.delete(entryKey)
    }
  }

  const ensureEntry = (cache: Cache, key: unknown): ResourceEntry<T, Args> => {
    let state = cache.get(key)
    if (state) {
      // Refresh recency so eviction drops the least-recently-used entries.
      cache.delete(key)
      cache.set(key, state)
      return state
    }
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
      inFlightArgs: undefined,
      controller: undefined,
    }
    cache.set(key, state)
    // The caller may start work on this new entry immediately after return.
    // Do not evict it in the brief interval before inFlight is assigned.
    evictOverflowEntries(cache, state)
    return state
  }

  const isExpired = (entry: ResourceEntry<T, Args>): boolean => {
    if (resolvedCacheOptions.mode === 'none') return true
    if (!Number.isFinite(resolvedCacheOptions.ttlMs)) return false
    if (entry.expiresAt === undefined) return false
    return entry.expiresAt <= Date.now()
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
    cache: Cache,
    entry: ResourceEntry<T, Args>,
    key: unknown,
    args: Args,
    options: { isRevalidating?: boolean; createToken?: boolean } = {},
  ) => {
    const createToken = options.createToken !== false
    const isRevalidating = options.isRevalidating === true
    // The entry is keyed by request identity, so any in-flight fetch already
    // serves these args - reuse it instead of abort/restart churn. Callers
    // that genuinely need a fresh fetch (refresh, mutate) abort explicitly
    // before calling startFetch.
    if (entry.inFlight) {
      if (createToken && useSuspense && !entry.hasValue && !entry.pendingToken) {
        entry.pendingToken = createSuspenseToken()
      }
      return
    }
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

    const shouldSuspend = createToken && useSuspense && !entry.hasValue
    entry.pendingToken = shouldSuspend ? createSuspenseToken() : null

    let request: Promise<T>
    try {
      request = Promise.resolve(fetcher({ signal: controller.signal }, args))
    } catch (err) {
      request = Promise.reject(err)
    }

    const fetchPromise = request
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
        if (entry.generation !== currentGen || entry.inFlight !== fetchPromise) return
        entry.inFlight = undefined
        entry.inFlightArgs = undefined
        if (entry.controller === controller) {
          entry.controller = undefined
        }
        // A full cache may temporarily retain in-flight entries. Re-apply the
        // bound once work settles so concurrent prefetches cannot leave it
        // permanently above maxEntries.
        evictOverflowEntries(cache)
      })

    entry.inFlight = fetchPromise
    entry.inFlightArgs = args

    if (!shouldSuspend) {
      onCleanup(() => {
        if (resolvedCacheOptions.mode === 'none') {
          controller.abort()
          cache.delete(key)
        }
      })
    }
  }

  const resolvePendingToken = (entry: ResourceEntry<T, Args>) => {
    if (!entry.pendingToken) return
    entry.pendingToken.resolve()
    entry.pendingToken = null
  }

  const invalidate = (key?: unknown) => {
    const cache = resolveCache()
    if (key === undefined) {
      cache.forEach(entry => {
        entry.controller?.abort()
        resolvePendingToken(entry)
        entry.version(entry.version() + 1)
        entry.expiresAt = Date.now() - 1
      })
      cache.clear()
      return
    }
    const normalizedKey = structuralArgsKey(key)
    const entry = cache.get(normalizedKey)
    if (entry) {
      entry.controller?.abort()
      resolvePendingToken(entry)
      entry.version(entry.version() + 1)
      entry.expiresAt = Date.now() - 1
      cache.delete(normalizedKey)
    }
  }

  function prefetch(args: Args, keyOverride?: unknown) {
    const cache = resolveCache()
    const hasKeyOverride = arguments.length >= 2
    const key = hasKeyOverride ? structuralArgsKey(keyOverride) : computeKey(args)
    const entry = ensureEntry(cache, key)
    const usableData = entry.hasValue && !isExpired(entry)
    if (!usableData) {
      entry.lastArgs = args
      entry.lastVersion = entry.version()
      startFetch(cache, entry, key, args, { createToken: false })
    }
  }

  const mutate = (
    argsAccessor: (() => Args) | Args,
    value: T | ((prev: T | undefined) => T),
    options?: { key?: unknown; revalidate?: boolean },
  ) => {
    const cache = resolveCache()
    const args = readArgs(argsAccessor)
    const hasKeyOverride = !!options && Object.prototype.hasOwnProperty.call(options, 'key')
    const key = hasKeyOverride ? structuralArgsKey(options.key) : computeKey(args)
    const entry = ensureEntry(cache, key)
    const prevValue = entry.data()
    const nextValue =
      typeof value === 'function' ? (value as (prev: T | undefined) => T)(prevValue) : value

    entry.controller?.abort()
    entry.inFlight = undefined
    entry.inFlightArgs = undefined
    entry.generation += 1

    entry.data(nextValue)
    entry.hasValue = true
    entry.status = 'success'
    entry.loading(false)
    entry.error(undefined)
    markExpiry(entry)
    entry.lastArgs = args
    entry.lastVersion = entry.version()

    if (entry.pendingToken) {
      entry.pendingToken.resolve()
      entry.pendingToken = null
    }

    if (options?.revalidate) {
      entry.version(entry.version() + 1)
    }
  }

  return {
    read(argsAccessor: (() => Args) | Args): ResourceResult<T> {
      // Capture the active request cache once. Reactive re-runs may happen
      // after the synchronous SSR session stack has unwound, but they still
      // belong to the request that created this read.
      const cache = resolveCache()
      const entryRef = createSignal<ResourceEntry<T, Args> | null>(null)

      createEffect(() => {
        const key = computeKey(argsAccessor)
        const entry = ensureEntry(cache, key)
        entryRef(entry)
        const args = readArgs(argsAccessor)
        const currentVersion = entry.version()
        const expired = isExpired(entry)
        // The cache key is the request identity: a fresh args object that maps
        // to the same key is the same request, so default-keyed resources never
        // treat it as a change. Custom-keyed resources can see different args
        // under one key; compare those structurally, not by reference.
        const neverFetched = entry.status === 'idle' && !entry.hasValue && !entry.inFlight
        const argsChanged = hasCustomKey
          ? structuralArgsKey(args) !== structuralArgsKey(entry.lastArgs)
          : false
        const versionChanged = entry.lastVersion !== currentVersion
        const resetToken = readResetToken()
        const resetChanged = entry.lastReset !== resetToken
        // For stale-while-revalidate: if we have cached data, don't treat expired as requiring immediate refetch
        // We'll handle the revalidation separately to show stale data without loading state
        const canUseStaleData =
          resolvedCacheOptions.staleWhileRevalidate && entry.hasValue && expired
        const shouldRefetch =
          neverFetched ||
          (expired && !canUseStaleData) ||
          argsChanged ||
          versionChanged ||
          resetChanged ||
          (entry.status === 'error' && !resolvedCacheOptions.cacheErrors)
        const shouldAttachSuspenseToken =
          useSuspense && !!entry.inFlight && !entry.hasValue && !entry.pendingToken

        entry.lastArgs = args
        entry.lastVersion = currentVersion
        entry.lastReset = resetToken

        if (shouldRefetch || shouldAttachSuspenseToken) {
          if (entry.inFlight && (argsChanged || versionChanged)) {
            entry.controller?.abort()
            entry.inFlight = undefined
          }
          if (resetChanged) {
            entry.hasValue = false
            entry.expiresAt = Date.now() - 1
          }
          startFetch(cache, entry, key, args as Args)
        } else if (canUseStaleData && entry.inFlight === undefined) {
          // stale-while-revalidate: return stale data immediately, refresh in background
          // Pass isRevalidating=true to avoid showing loading state
          startFetch(cache, entry, key, args as Args, { isRevalidating: true })
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
    mutate,
  }
}
