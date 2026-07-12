/**
 * @fileoverview Data loading utilities for @fictjs/router
 *
 * This module provides utilities for loading data in routes,
 * including query caching, actions, and preloading.
 */

import { createEffect, batch, createSuspenseToken } from '@fictjs/runtime'
import { createSignal, type Signal } from '@fictjs/runtime/advanced'
import { __fictGetCurrentSSRSession, __fictIsSSRSessionActive } from '@fictjs/runtime/internal'

import type {
  QueryFunction,
  QueryCacheEntry,
  ActionFunction,
  Action,
  Submission,
  NavigationIntent,
  Params,
} from './types'
import { hashQueryArgs } from './utils'

// ============================================================================
// Query Cache
// ============================================================================

/** Cache duration in milliseconds (default: 3 minutes) */
const CACHE_DURATION = 3 * 60 * 1000

/** Preload cache duration in milliseconds (default: 5 seconds) */
const PRELOAD_CACHE_DURATION = 5 * 1000

/** Maximum cache size to prevent memory spikes */
const MAX_CACHE_SIZE = 500

/** Cleanup interval when cache is small (60 seconds) */
const NORMAL_CLEANUP_INTERVAL = 60 * 1000

/** Cleanup interval when cache is large (10 seconds) */
const FAST_CLEANUP_INTERVAL = 10 * 1000

type QueryCache = Map<string, QueryCacheEntry<unknown>>
type SSRSession = NonNullable<ReturnType<typeof __fictGetCurrentSSRSession>>
type QueryInvocationIntent = Extract<NavigationIntent, 'navigate' | 'preload'>

/** Shared browser cache. SSR requests use isolated caches below. */
const sharedQueryCache: QueryCache = new Map()

/** Request-local caches are released with their SSR sessions. */
let requestQueryCaches = new WeakMap<SSRSession, QueryCache>()

/** Internal preload entry points keyed by the public query function. */
const queryPreloaders = new WeakMap<object, (args: unknown[]) => void>()

function resolveQueryCache(): QueryCache {
  const session = __fictGetCurrentSSRSession()
  if (!session) {
    // If an SSR integration loses its async carrier, fail closed instead of
    // putting request data in the process-wide browser cache. The temporary
    // cache is captured by the query call for the rest of its async work.
    return __fictIsSSRSessionActive() ? new Map() : sharedQueryCache
  }

  let cache = requestQueryCaches.get(session)
  if (!cache) {
    cache = new Map()
    requestQueryCaches.set(session, cache)
  }
  return cache
}

/** Cache cleanup timer */
let cacheCleanupTimer: ReturnType<typeof setInterval> | undefined

/** Current cleanup interval */
let currentCleanupInterval = NORMAL_CLEANUP_INTERVAL

/**
 * Evict oldest entries when cache exceeds max size
 */
function evictOldestEntries(queryCache: QueryCache) {
  if (queryCache.size <= MAX_CACHE_SIZE) return

  // Sort entries by timestamp (oldest first)
  const entries = Array.from(queryCache.entries()).sort((a, b) => a[1].timestamp - b[1].timestamp)

  // Remove oldest entries until we're under the limit
  const toRemove = queryCache.size - MAX_CACHE_SIZE
  for (let i = 0; i < toRemove && i < entries.length; i++) {
    queryCache.delete(entries[i]![0])
  }
}

/**
 * Run cache cleanup
 */
function runCacheCleanup() {
  const now = Date.now()

  for (const [key, entry] of sharedQueryCache) {
    const maxAge = entry.intent === 'preload' ? PRELOAD_CACHE_DURATION : CACHE_DURATION

    if (now - entry.timestamp > maxAge) {
      sharedQueryCache.delete(key)
    }
  }

  // Adjust cleanup interval based on cache size
  const newInterval =
    sharedQueryCache.size > MAX_CACHE_SIZE / 2 ? FAST_CLEANUP_INTERVAL : NORMAL_CLEANUP_INTERVAL

  if (newInterval !== currentCleanupInterval) {
    currentCleanupInterval = newInterval
    // Restart with new interval
    stopCacheCleanup()
    startCacheCleanup()
  }
}

/**
 * Start the cache cleanup interval
 */
function startCacheCleanup() {
  // Request-scoped SSR caches are released with their session WeakMap keys.
  // A server-side interval would do no useful work and keep the process alive.
  if (typeof window === 'undefined') return
  if (cacheCleanupTimer) return

  cacheCleanupTimer = setInterval(runCacheCleanup, currentCleanupInterval)
}

/**
 * Stop the cache cleanup interval
 */
function stopCacheCleanup() {
  if (cacheCleanupTimer) {
    clearInterval(cacheCleanupTimer)
    cacheCleanupTimer = undefined
  }
}

// ============================================================================
// Query Function
// ============================================================================

/**
 * Create a cached query function
 *
 * @example
 * ```tsx
 * const getUser = query(
 *   async (id: string) => {
 *     const response = await fetch(`/api/users/${id}`)
 *     return response.json()
 *   },
 *   'getUser'
 * )
 *
 * // In a component
 * function UserProfile({ id }) {
 *   const user = getUser(id)
 *   return <div>{user()?.name}</div>
 * }
 * ```
 */
export function query<T, Args extends unknown[]>(
  fn: QueryFunction<T, Args>,
  name: string,
): (...args: Args) => () => T | undefined {
  startCacheCleanup()

  const invoke = (intent: QueryInvocationIntent, args: Args): (() => T | undefined) => {
    // Capture the request cache before starting asynchronous work. Promise
    // callbacks run after the synchronous SSR session stack has unwound.
    const queryCache = resolveQueryCache()
    const cacheKey = `${name}:${hashQueryArgs(args)}`

    // Check cache
    const cached = queryCache.get(cacheKey) as QueryCacheEntry<T> | undefined
    if (cached?.hasResult && cached.settled !== false) {
      // Check if cache is still valid
      const maxAge = cached.intent === 'preload' ? PRELOAD_CACHE_DURATION : CACHE_DURATION

      if (Date.now() - cached.timestamp < maxAge) {
        if (intent === 'navigate') cached.intent = 'navigate'
        return () => cached.result
      }
    }

    // Create reactive signal for the result
    const resultSignal = createSignal<T | undefined>(cached?.result)
    const errorSignal = createSignal<unknown>(undefined)
    const loadingSignal = createSignal<boolean>(true)

    if (cached && !cached.settled) {
      if (intent === 'navigate') cached.intent = 'navigate'
      void cached.promise.then(result => {
        batch(() => {
          resultSignal(result)
          loadingSignal(false)
        })
      })
      return () => resultSignal()
    }

    // Fetch the data. Query functions may throw before returning a promise;
    // normalize that path so failures follow the same internal error state.
    let fetchResult: T | Promise<T>
    try {
      fetchResult = fn(...args)
    } catch (error) {
      fetchResult = Promise.reject(error)
    }
    const promise = Promise.resolve(fetchResult)
      .then(result => {
        // Update cache
        const entry: QueryCacheEntry<T> = {
          timestamp: Date.now(),
          promise: promise as Promise<T>,
          settled: true,
          result,
          hasResult: true,
          intent,
        }
        const currentEntry = queryCache.get(cacheKey)
        if (currentEntry?.promise === (promise as Promise<T>)) {
          entry.intent = currentEntry.intent
          queryCache.set(cacheKey, entry)
          evictOldestEntries(queryCache)
        }

        // Update signals
        batch(() => {
          resultSignal(result)
          loadingSignal(false)
        })

        return result
      })
      .catch(error => {
        batch(() => {
          errorSignal(error)
          loadingSignal(false)
        })
        const entry = queryCache.get(cacheKey) as QueryCacheEntry<T> | undefined
        if (entry?.promise === (promise as Promise<T>)) {
          queryCache.delete(cacheKey)
        }
        return undefined
      })

    // Store promise in cache immediately for deduplication
    const pendingEntry: QueryCacheEntry<T> = {
      timestamp: Date.now(),
      promise: promise as Promise<T>,
      settled: false,
      intent,
      ...(cached?.hasResult ? { result: cached.result as T, hasResult: true } : {}),
    }
    queryCache.set(cacheKey, pendingEntry)

    return () => resultSignal()
  }

  const queryFn = (...args: Args) => invoke('navigate', args)
  queryPreloaders.set(queryFn, args => {
    invoke('preload', args as Args)
  })
  return queryFn
}

/**
 * Invalidate cached queries by key pattern
 */
export function revalidate(keys?: string | string[] | RegExp): void {
  const queryCache = resolveQueryCache()
  if (!keys) {
    // Invalidate all
    queryCache.clear()
    return
  }

  if (typeof keys === 'string') {
    // Single key or prefix
    for (const cacheKey of queryCache.keys()) {
      if (cacheKey.startsWith(keys)) {
        queryCache.delete(cacheKey)
      }
    }
    return
  }

  if (Array.isArray(keys)) {
    // Multiple keys
    for (const key of keys) {
      for (const cacheKey of queryCache.keys()) {
        if (cacheKey.startsWith(key)) {
          queryCache.delete(cacheKey)
        }
      }
    }
    return
  }

  if (keys instanceof RegExp) {
    // Global/sticky regexes mutate lastIndex. Test each cache key from the
    // same starting position and leave the caller's RegExp state untouched.
    const originalLastIndex = keys.lastIndex
    try {
      for (const cacheKey of queryCache.keys()) {
        keys.lastIndex = 0
        if (keys.test(cacheKey)) {
          queryCache.delete(cacheKey)
        }
      }
    } finally {
      keys.lastIndex = originalLastIndex
    }
  }
}

// ============================================================================
// Action Function
// ============================================================================

/** Global action registry */
const actionRegistry = new Map<string, ActionFunction<unknown>>()

/** Registered action objects used by declarative Forms. */
const registeredActions = new Map<string, Action<unknown>>()

/** Preserve each action object's handler even when another action reuses its URL. */
let actionHandlers = new WeakMap<Action<unknown>, ActionFunction<unknown>>()

/** Submission counter for unique keys */
let submissionCounter = 0

/**
 * Create an action for form submissions
 *
 * @example
 * ```tsx
 * const createUser = action(
 *   async (formData, { params }) => {
 *     const response = await fetch('/api/users', {
 *       method: 'POST',
 *       body: formData,
 *     })
 *     return response.json()
 *   },
 *   'createUser'
 * )
 *
 * // In a component
 * <Form action={createUser}>
 *   <input name="name" />
 *   <button type="submit">Create</button>
 * </Form>
 * ```
 */
export function action<T>(fn: ActionFunction<T>, name?: string): Action<T> {
  const actionName = name || `action-${++submissionCounter}`
  const actionUrl = `/_action/${encodeURIComponent(actionName)}`

  const createdAction: Action<T> = {
    url: actionUrl,
    name: actionName,
    submit: async (formData: FormData, params: Params = {}): Promise<T> => {
      return executeActionHandler(fn, formData, params, actionUrl, 'POST')
    },
  }

  // Keep the public handler lookup while also retaining the Action object that
  // declarative Forms need in order to share the submission state machine.
  actionRegistry.set(actionUrl, fn as ActionFunction<unknown>)
  registeredActions.set(actionUrl, createdAction as Action<unknown>)
  actionHandlers.set(createdAction as Action<unknown>, fn as ActionFunction<unknown>)

  return createdAction
}

async function executeActionHandler<T>(
  handler: ActionFunction<T>,
  formData: FormData,
  params: Params,
  url: string,
  method: string,
): Promise<T> {
  // Resolve relative action URLs for Node.js/jsdom while retaining the actual
  // form URL and method when a declarative Form invokes the action.
  const baseUrl =
    typeof window !== 'undefined' && window.location ? window.location.origin : 'http://localhost'
  const requestInit: RequestInit = { method }
  if (method !== 'GET' && method !== 'HEAD') {
    requestInit.body = formData
  }
  const request = new Request(new URL(url, baseUrl).href, requestInit)

  return handler(formData, { params, request })
}

/**
 * Get a registered action by URL
 */
export function getAction(url: string): ActionFunction<unknown> | undefined {
  return actionRegistry.get(url)
}

/** Get the Action object associated with a declarative action URL. */
export function getRegisteredAction(url: string): Action<unknown> | undefined {
  return registeredActions.get(url)
}

// ============================================================================
// Submission Tracking
// ============================================================================

type SubmissionMap = Map<string, Submission<unknown>>
type SubmissionStore = Signal<SubmissionMap>
type SubmissionExecutor<T> = (formData: FormData, params: Params) => Promise<T>

/** Associate tracked submissions with their action without exposing an internal field publicly. */
const submissionActionUrls = new WeakMap<Submission<unknown>, string>()

/** Shared browser submissions. SSR requests use isolated stores below. */
const sharedActiveSubmissions = createSignal<SubmissionMap>(new Map())

/** Request-local submission stores are released with their SSR sessions. */
let requestActiveSubmissions = new WeakMap<SSRSession, SubmissionStore>()

function createSubmissionStore(): SubmissionStore {
  return createSignal<SubmissionMap>(new Map())
}

function resolveSubmissionStore(): SubmissionStore {
  const session = __fictGetCurrentSSRSession()
  if (!session) {
    // Match query-cache isolation: if an SSR integration loses its async
    // carrier, keep this invocation out of the process-wide browser store.
    // Callers capture the temporary store for all of their later callbacks.
    return __fictIsSSRSessionActive() ? createSubmissionStore() : sharedActiveSubmissions
  }

  let store = requestActiveSubmissions.get(session)
  if (!store) {
    store = createSubmissionStore()
    requestActiveSubmissions.set(session, store)
  }
  return store
}

/**
 * Use submission state for an action
 */
export function useSubmission<T>(actionOrUrl: Action<T> | string): () => Submission<T> | undefined {
  const url = typeof actionOrUrl === 'string' ? actionOrUrl : actionOrUrl.url
  const activeSubmissions = resolveSubmissionStore()

  return () => {
    const submissions = activeSubmissions()
    let latest: Submission<T> | undefined
    for (const submission of submissions.values()) {
      if (submissionActionUrls.get(submission) === url) {
        latest = submission as Submission<T>
      }
    }
    return latest
  }
}

/**
 * Use all active submissions
 */
export function useSubmissions(): () => Submission<unknown>[] {
  const activeSubmissions = resolveSubmissionStore()
  return () => Array.from(activeSubmissions().values())
}

/** Submit using a submission store already captured by the public entry point. */
async function submitActionInStore<T>(
  action: Action<T>,
  formData: FormData,
  params: Params,
  activeSubmissions: SubmissionStore,
  execute: SubmissionExecutor<T>,
  submissionKey?: string,
): Promise<T> {
  const key = submissionKey ?? `submission-${++submissionCounter}`

  // Create submission object
  const submission: Submission<T> = {
    key,
    formData,
    state: 'submitting',
    clear: () => {
      const submissions = new Map(activeSubmissions())
      if (submissions.get(key) !== submission) return
      submissions.delete(key)
      activeSubmissions(submissions)
    },
    retry: () => {
      // The retried submission records its own idle/error state. Since retry is
      // intentionally a void API, consume the returned rejection after that
      // state update instead of leaking an unhandled promise.
      void submitActionInStore(
        action,
        formData,
        params,
        activeSubmissions,
        execute,
        submissionKey,
      ).catch(() => {})
    },
  }
  submissionActionUrls.set(submission as Submission<unknown>, action.url)

  // Add to active submissions
  const submissions = new Map(activeSubmissions())
  submissions.set(key, submission as Submission<unknown>)
  activeSubmissions(submissions)

  try {
    // Execute the action
    const result = await execute(formData, params)

    // Update submission with result
    submission.result = result
    submission.state = 'idle'

    // Update active submissions
    const updatedSubmissions = new Map(activeSubmissions())
    if (updatedSubmissions.get(key) === submission) {
      updatedSubmissions.set(key, submission as Submission<unknown>)
      activeSubmissions(updatedSubmissions)
    }

    return result
  } catch (error) {
    // Update submission with error
    submission.error = error
    submission.state = 'idle'

    // Update active submissions
    const updatedSubmissions = new Map(activeSubmissions())
    if (updatedSubmissions.get(key) === submission) {
      updatedSubmissions.set(key, submission as Submission<unknown>)
      activeSubmissions(updatedSubmissions)
    }

    throw error
  }
}

/**
 * Submit an action and track the submission
 */
export function submitAction<T>(
  action: Action<T>,
  formData: FormData,
  params: Params = {},
): Promise<T> {
  // Resolve once while the caller's SSR session is available. Every async
  // settle, clear, and retry continues to use this captured store.
  return submitActionInStore(
    action,
    formData,
    params,
    resolveSubmissionStore(),
    (submittedFormData, submittedParams) => action.submit(submittedFormData, submittedParams),
  )
}

/**
 * Submit an action from a declarative Form while preserving its actual request.
 * This is intentionally internal to the router package rather than re-exported.
 */
export function submitActionFromForm<T>(
  action: Action<T>,
  formData: FormData,
  params: Params,
  request: { url: string; method: string },
  submissionKey?: string,
): Promise<T> {
  const registeredHandler = actionHandlers.get(action as Action<unknown>) as
    | ActionFunction<T>
    | undefined
  const execute: SubmissionExecutor<T> = registeredHandler
    ? (submittedFormData, submittedParams) =>
        executeActionHandler(
          registeredHandler,
          submittedFormData,
          submittedParams,
          request.url,
          request.method,
        )
    : (submittedFormData, submittedParams) => action.submit(submittedFormData, submittedParams)

  return submitActionInStore(
    action,
    formData,
    params,
    resolveSubmissionStore(),
    execute,
    submissionKey,
  )
}

// ============================================================================
// Preloading
// ============================================================================

/**
 * Preload a query for faster navigation
 */
export function preloadQuery<T, Args extends unknown[]>(
  queryFn: (...args: Args) => () => T | undefined,
  ...args: Args
): void {
  const preload = queryPreloaders.get(queryFn)
  if (preload) {
    preload(args)
    return
  }
  queryFn(...args)
}

/**
 * Create a preload function for a route
 */
export function createPreload<T>(
  fn: (args: { params: Params; intent: NavigationIntent }) => T | Promise<T>,
): (args: { params: Params; intent: NavigationIntent }) => Promise<T> {
  return async args => {
    return fn(args)
  }
}

// ============================================================================
// Resource (async data with Suspense support)
// ============================================================================

/**
 * Resource state
 */
export interface Resource<T> {
  /** Get current data (undefined during loading or on error) */
  (): T | undefined
  /** Whether the resource is currently loading */
  loading: () => boolean
  /** Error if the fetch failed, undefined otherwise */
  error: () => unknown
  /** Latest successfully loaded value (persists during reloads) */
  latest: () => T | undefined
  /** Trigger a refetch, returns the result or undefined on error */
  refetch: () => Promise<T | undefined>
}

/** Resource behavior options. */
export interface ResourceOptions {
  /** Throw a Suspense token while the current request is loading. */
  suspense?: boolean
}

/**
 * Create a resource for async data loading
 * Integrates with Suspense for loading states
 *
 * @example
 * ```tsx
 * const userResource = createResource(
 *   () => userId,
 *   async (id) => fetch(`/api/users/${id}`).then(r => r.json()),
 *   { suspense: true }
 * )
 *
 * function UserProfile() {
 *   const user = userResource()
 *   return <div>{user?.name}</div>
 * }
 * ```
 */
export function createResource<T, S = unknown>(
  source: () => S,
  fetcher: (source: S) => T | Promise<T>,
  options: ResourceOptions = {},
): Resource<T> {
  const dataSignal = createSignal<T | undefined>(undefined)
  const loadingSignal = createSignal<boolean>(true)
  const errorSignal = createSignal<unknown>(undefined)
  const latestSignal = createSignal<T | undefined>(undefined)

  let currentSource: S
  let hasCurrentSource = false
  let fetchId = 0 // Used to prevent race conditions
  let pendingToken: ReturnType<typeof createSuspenseToken> | null = null

  const resolvePendingToken = () => {
    const token = pendingToken
    pendingToken = null
    token?.resolve()
  }

  /**
   * Internal fetch function with race condition protection
   * Returns T on success, undefined on error (error is stored in errorSignal)
   */
  const doFetch = async (s: S, id: number): Promise<T | undefined> => {
    // Wake a boundary waiting on the superseded request. Its retry will attach
    // to this request's token if the new request is still loading.
    resolvePendingToken()
    batch(() => {
      dataSignal(undefined)
      loadingSignal(true)
      errorSignal(undefined)
    })

    try {
      const result = await fetcher(s)

      // Only apply results if this fetch is still current
      // (prevents race conditions when source changes rapidly)
      if (id === fetchId) {
        batch(() => {
          dataSignal(result)
          latestSignal(result)
          loadingSignal(false)
        })
        resolvePendingToken()
        return result
      }

      // This fetch was superseded, return undefined
      return undefined
    } catch (err) {
      // Only apply error if this fetch is still current
      if (id === fetchId) {
        batch(() => {
          dataSignal(undefined)
          errorSignal(err)
          loadingSignal(false)
        })
        const token = pendingToken
        pendingToken = null
        token?.reject(err)
      }

      // Return undefined on error - error is accessible via resource.error()
      return undefined
    }
  }

  // Initial fetch and tracking
  createEffect(() => {
    const s = source()

    // Only refetch if source changed
    if (!hasCurrentSource || s !== currentSource) {
      currentSource = s
      hasCurrentSource = true
      // Increment fetchId to invalidate any pending fetches
      const currentFetchId = ++fetchId
      doFetch(s, currentFetchId)
    }
  })

  const resource = (() => {
    const loading = loadingSignal()
    const data = dataSignal()
    if (options.suspense && loading) {
      pendingToken ??= createSuspenseToken()
      throw pendingToken.token
    }
    return data
  }) as Resource<T>

  resource.loading = () => loadingSignal()
  resource.error = () => errorSignal()
  resource.latest = () => latestSignal()
  resource.refetch = () => {
    const currentFetchId = ++fetchId
    return doFetch(currentSource, currentFetchId)
  }

  return resource
}

// ============================================================================
// Cleanup
// ============================================================================

/**
 * Clean up router data utilities
 */
export function cleanupDataUtilities(): void {
  stopCacheCleanup()
  sharedQueryCache.clear()
  requestQueryCaches = new WeakMap()
  actionRegistry.clear()
  registeredActions.clear()
  actionHandlers = new WeakMap()
  sharedActiveSubmissions(new Map())
  requestActiveSubmissions = new WeakMap()
}
