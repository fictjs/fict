import { createSignal, createEffect, onCleanup, createSuspenseToken } from 'fict-runtime'

export interface ResourceResult<T> {
  data: T | undefined
  loading: boolean
  error: unknown
  refresh: () => void
}

export interface ResourceOptions<T, Args> {
  key?: unknown[]
  fetch: (ctx: { signal: AbortSignal }, args: Args) => Promise<T>
  suspense?: boolean
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
  const cache = new Map<unknown, ResourceState>()

  interface ResourceState {
    data: ReturnType<typeof createSignal<T | undefined>>
    loading: ReturnType<typeof createSignal<boolean>>
    error: ReturnType<typeof createSignal<unknown>>
    version: ReturnType<typeof createSignal<number>>
    pendingToken: ReturnType<typeof createSuspenseToken> | null
    lastArgs: Args | undefined
    lastVersion: number
    hasValue: boolean
    activeVersion: number
    refresh: () => void
  }

  return {
    read(argsAccessor: () => Args | Args): ResourceResult<T> {
      const key =
        typeof optionsOrFetcher === 'object' && optionsOrFetcher.key
          ? optionsOrFetcher.key
          : typeof argsAccessor === 'function'
            ? argsAccessor
            : argsAccessor

      let state = cache.get(key)
      if (!state) {
        const data = createSignal<T | undefined>(undefined)
        const loading = createSignal(true)
        const error = createSignal<unknown>(undefined)
        const version = createSignal(0)
        state = {
          data,
          loading,
          error,
          version,
          pendingToken: null,
          lastArgs: undefined,
          lastVersion: -1,
          hasValue: false,
          activeVersion: -1,
          refresh: () => version(version() + 1),
        }
        cache.set(key, state)
      }

      createEffect(() => {
        // Track args
        const args =
          typeof argsAccessor === 'function' ? (argsAccessor as () => Args)() : argsAccessor

        // Track version for manual refresh
        const currentVersion = state!.version()

        // Skip refetch if args/version unchanged and we already have data
        if (state!.hasValue && state!.lastArgs === args && state!.lastVersion === currentVersion) {
          return
        }
        state!.lastArgs = args
        state!.lastVersion = currentVersion

        const controller = new AbortController()
        state!.activeVersion = currentVersion
        const versionAtStart = currentVersion

        state!.loading(true)
        state!.error(undefined)

        state!.pendingToken = useSuspense ? createSuspenseToken() : null

        onCleanup(() => {
          if (!useSuspense) {
            controller.abort()
            cache.delete(key)
          }
        })

        fetcher({ signal: controller.signal }, args)
          .then(res => {
            if (controller.signal.aborted || state!.activeVersion !== versionAtStart) return
            state!.data(res)
            state!.loading(false)
            state!.hasValue = true
            if (state!.pendingToken) {
              state!.pendingToken.resolve()
              state!.pendingToken = null
            }
          })
          .catch(err => {
            if (controller.signal.aborted || state!.activeVersion !== versionAtStart) return
            state!.error(err)
            state!.loading(false)
            if (state!.pendingToken) {
              state!.pendingToken.reject(err)
              state!.pendingToken = null
            }
          })
      })

      return {
        get data() {
          if (useSuspense && state!.loading() && state!.pendingToken) {
            throw state!.pendingToken.token
          }
          return state!.data()
        },
        get loading() {
          return state!.loading()
        },
        get error() {
          return state!.error()
        },
        refresh: state!.refresh,
      }
    },
  }
}
