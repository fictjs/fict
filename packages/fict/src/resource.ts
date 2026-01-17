import { createEffect, onCleanup, createSuspenseToken } from '@fictjs/runtime'
import { createSignal } from '@fictjs/runtime/advanced'

export interface ResourceResult<T> {
  data: T | undefined
  loading: boolean
  error: unknown
  refresh: () => void
}

export interface ResourceCacheOptions {
  mode?: 'memory' | 'none'
  ttlMs?: number
  staleWhileRevalidate?: boolean
  cacheErrors?: boolean
}

export interface ResourceOptions<T, Args> {
  key?: unknown
  fetch: (ctx: { signal: AbortSignal }, args: Args) => Promise<T>
  suspense?: boolean
  cache?: ResourceCacheOptions
  reset?: unknown | (() => unknown)
}

interface ResourceEntry<T, Args> {
  data: ReturnType<typeof createSignal<T | undefined>>
  loading: ReturnType<typeof createSignal<boolean>>
  error: ReturnType<typeof createSignal<unknown>>
  version: ReturnType<typeof createSignal<number>>
  pendingToken: ReturnType<typeof createSuspenseToken> | null
  lastArgs: Args | undefined
  lastVersion: number
  lastReset: unknown
  hasValue: boolean
  status: 'idle' | 'pending' | 'success' | 'error'
  generation: number
  expiresAt: number | undefined
  inFlight: Promise<void> | undefined
  controller: AbortController | undefined
}

const defaultCacheOptions: Required<ResourceCacheOptions> = {
  mode: 'memory',
  ttlMs: Number.POSITIVE_INFINITY,
  staleWhileRevalidate: false,
  cacheErrors: false,
}

/**
 * Creates a resource factory that can be read with arguments.
 *
 * @param optionsOrFetcher - Configuration object or fetcher function
 */
export function resource<T, Args = void>(
  optionsOrFetcher:
    | ((ctx: { signal: AbortSignal }, args: Args) => Promise<T>)
    | ResourceOptions<T, Args>,
) {
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
