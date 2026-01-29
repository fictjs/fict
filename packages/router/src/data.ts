/**
 * @fileoverview Data loading utilities for @fictjs/router
 *
 * This module provides utilities for loading data in routes,
 * including query caching, actions, and preloading.
 */

import { createEffect, batch } from '@fictjs/runtime'
import { createSignal } from '@fictjs/runtime/advanced'

import type {
  QueryFunction,
  QueryCacheEntry,
  ActionFunction,
  Action,
  Submission,
  NavigationIntent,
  Params,
} from './types'
import { hashParams } from './utils'

// ============================================================================
// Query Cache
// ============================================================================

/** Cache duration in milliseconds (default: 3 minutes) */
const CACHE_DURATION = 3 * 60 * 1000

/** Preload cache duration in milliseconds (default: 5 seconds) */
const PRELOAD_CACHE_DURATION = 5 * 1000

/** Global query cache */
const queryCache = new Map<string, QueryCacheEntry<unknown>>()

/** Cache cleanup timer */
let cacheCleanupTimer: ReturnType<typeof setInterval> | undefined

/**
 * Start the cache cleanup interval
 */
function startCacheCleanup() {
  if (cacheCleanupTimer) return

  cacheCleanupTimer = setInterval(() => {
    const now = Date.now()

    for (const [key, entry] of queryCache) {
      const maxAge = entry.intent === 'preload' ? PRELOAD_CACHE_DURATION : CACHE_DURATION

      if (now - entry.timestamp > maxAge) {
        queryCache.delete(key)
      }
    }
  }, 60 * 1000) // Run cleanup every minute
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

  return (...args: Args) => {
    const cacheKey = `${name}:${hashParams(args as unknown as Record<string, unknown>)}`

    // Check cache
    const cached = queryCache.get(cacheKey) as QueryCacheEntry<T> | undefined
    if (cached && cached.result !== undefined) {
      // Check if cache is still valid
      const maxAge = cached.intent === 'preload' ? PRELOAD_CACHE_DURATION : CACHE_DURATION

      if (Date.now() - cached.timestamp < maxAge) {
        return () => cached.result
      }
    }

    // Create reactive signal for the result
    const resultSignal = createSignal<T | undefined>(cached?.result)
    const errorSignal = createSignal<unknown>(undefined)
    const loadingSignal = createSignal<boolean>(true)

    // Fetch the data
    const promise = Promise.resolve(fn(...args))
      .then(result => {
        // Update cache
        const entry: QueryCacheEntry<T> = {
          timestamp: Date.now(),
          promise,
          result,
          intent: 'navigate',
        }
        queryCache.set(cacheKey, entry)

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
        throw error
      })

    // Store promise in cache immediately for deduplication
    if (!cached) {
      queryCache.set(cacheKey, {
        timestamp: Date.now(),
        promise: promise as Promise<unknown>,
        intent: 'navigate',
      })
    }

    return () => resultSignal()
  }
}

/**
 * Invalidate cached queries by key pattern
 */
export function revalidate(keys?: string | string[] | RegExp): void {
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
    // Regex pattern
    for (const cacheKey of queryCache.keys()) {
      if (keys.test(cacheKey)) {
        queryCache.delete(cacheKey)
      }
    }
  }
}

// ============================================================================
// Action Function
// ============================================================================

/** Global action registry */
const actionRegistry = new Map<string, ActionFunction<unknown>>()

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
  const actionUrl = `/_action/${actionName}`

  // Register the action
  actionRegistry.set(actionUrl, fn as ActionFunction<unknown>)

  return {
    url: actionUrl,
    name: actionName,
    submit: async (formData: FormData): Promise<T> => {
      // Create a mock request with a base URL for Node.js/jsdom compatibility
      const baseUrl =
        typeof window !== 'undefined' && window.location
          ? window.location.origin
          : 'http://localhost'
      const request = new Request(new URL(actionUrl, baseUrl).href, {
        method: 'POST',
        body: formData,
      })

      return fn(formData, { params: {}, request }) as Promise<T>
    },
  }
}

/**
 * Get a registered action by URL
 */
export function getAction(url: string): ActionFunction<unknown> | undefined {
  return actionRegistry.get(url)
}

// ============================================================================
// Submission Tracking
// ============================================================================

/** Active submissions */
const activeSubmissions = createSignal<Map<string, Submission<unknown>>>(new Map())

/**
 * Use submission state for an action
 */
export function useSubmission<T>(actionOrUrl: Action<T> | string): () => Submission<T> | undefined {
  const url = typeof actionOrUrl === 'string' ? actionOrUrl : actionOrUrl.url

  return () => {
    const submissions = activeSubmissions()
    return submissions.get(url) as Submission<T> | undefined
  }
}

/**
 * Use all active submissions
 */
export function useSubmissions(): () => Submission<unknown>[] {
  return () => Array.from(activeSubmissions().values())
}

/**
 * Submit an action and track the submission
 */
export async function submitAction<T>(
  action: Action<T>,
  formData: FormData,
  params: Params = {},
): Promise<T> {
  const key = `submission-${++submissionCounter}`

  // Create submission object
  const submission: Submission<T> = {
    key,
    formData,
    state: 'submitting',
    clear: () => {
      const submissions = new Map(activeSubmissions())
      submissions.delete(action.url)
      activeSubmissions(submissions)
    },
    retry: () => {
      submitAction(action, formData, params)
    },
  }

  // Add to active submissions
  const submissions = new Map(activeSubmissions())
  submissions.set(action.url, submission as Submission<unknown>)
  activeSubmissions(submissions)

  try {
    // Execute the action
    const result = await action.submit(formData)

    // Update submission with result
    submission.result = result
    submission.state = 'idle'

    // Update active submissions
    const updatedSubmissions = new Map(activeSubmissions())
    updatedSubmissions.set(action.url, submission as Submission<unknown>)
    activeSubmissions(updatedSubmissions)

    return result
  } catch (error) {
    // Update submission with error
    submission.error = error
    submission.state = 'idle'

    // Update active submissions
    const updatedSubmissions = new Map(activeSubmissions())
    updatedSubmissions.set(action.url, submission as Submission<unknown>)
    activeSubmissions(updatedSubmissions)

    throw error
  }
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
  // The query function handles caching internally
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

/**
 * Create a resource for async data loading
 * Integrates with Suspense for loading states
 *
 * @example
 * ```tsx
 * const userResource = createResource(
 *   () => userId,
 *   async (id) => fetch(`/api/users/${id}`).then(r => r.json())
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
): Resource<T> {
  const dataSignal = createSignal<T | undefined>(undefined)
  const loadingSignal = createSignal<boolean>(true)
  const errorSignal = createSignal<unknown>(undefined)
  const latestSignal = createSignal<T | undefined>(undefined)

  let currentSource: S
  let _currentPromise: Promise<T | undefined> | undefined

  /**
   * Internal fetch function
   * Returns T on success, undefined on error (error is stored in errorSignal)
   */
  const doFetch = async (s: S): Promise<T | undefined> => {
    loadingSignal(true)
    errorSignal(undefined)

    try {
      const result = await fetcher(s)

      batch(() => {
        dataSignal(result)
        latestSignal(result)
        loadingSignal(false)
      })

      return result
    } catch (err) {
      batch(() => {
        errorSignal(err)
        loadingSignal(false)
      })

      // Return undefined on error - error is accessible via resource.error()
      return undefined
    }
  }

  // Initial fetch and tracking
  createEffect(() => {
    const s = source()

    // Only refetch if source changed
    if (s !== currentSource) {
      currentSource = s
      _currentPromise = doFetch(s)
    }
  })

  const resource = (() => dataSignal()) as Resource<T>

  resource.loading = () => loadingSignal()
  resource.error = () => errorSignal()
  resource.latest = () => latestSignal()
  resource.refetch = () => doFetch(currentSource)

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
  queryCache.clear()
  actionRegistry.clear()
  activeSubmissions(new Map())
}
