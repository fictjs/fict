import { createSignal, createEffect, onCleanup } from 'fict-runtime'

export interface ResourceResult<T> {
  data: T | undefined
  loading: boolean
  error: unknown
  refresh: () => void
}

export interface ResourceOptions<T, Args> {
  key?: unknown[]
  fetch: (ctx: { signal: AbortSignal }, args: Args) => Promise<T>
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

  return {
    read(argsAccessor: () => Args | Args): ResourceResult<T> {
      const data = createSignal<T | undefined>(undefined)
      const loading = createSignal(true)
      const error = createSignal<unknown>(undefined)

      const refresh = () => {
        version(version() + 1)
      }

      const version = createSignal(0)

      createEffect(() => {
        // Track args
        const args =
          typeof argsAccessor === 'function' ? (argsAccessor as () => Args)() : argsAccessor

        // Track version for manual refresh
        version()

        const controller = new AbortController()

        loading(true)
        error(undefined)

        onCleanup(() => {
          controller.abort()
        })

        fetcher({ signal: controller.signal }, args)
          .then(res => {
            if (controller.signal.aborted) return
            data(res)
            loading(false)
          })
          .catch(err => {
            if (controller.signal.aborted) return
            error(err)
            loading(false)
          })
      })

      return {
        get data() {
          return data()
        },
        get loading() {
          return loading()
        },
        get error() {
          return error()
        },
        refresh,
      }
    },
  }
}
