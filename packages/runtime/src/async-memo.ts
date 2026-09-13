import {
  AsyncDisposedError,
  AsyncState,
  isAsyncPending,
  readAsyncSnapshot,
  type AsyncSnapshot,
} from './async-state'
import {
  createRootContext,
  destroyRoot,
  getCurrentRoot,
  withRootContext,
  type RootContext,
} from './lifecycle'
import {
  createAsyncGraphNode,
  isAsyncRejection,
  registerAsyncRead,
  registerAsyncRejection,
  untrack,
} from './signal'

export type AsyncContext<T> = { readonly signal: AbortSignal } & (
  | { readonly hasValue: false; readonly previous: undefined }
  | { readonly hasValue: true; readonly previous: T }
)

export interface AsyncMemoOptions {
  name?: string
  devToolsSource?: string
}

export interface AsyncMemo<T> {
  /** Read a current value; pending reads suspend and failed reads throw. */
  (): T
  /** Start or reconcile the computation and inspect its readiness. */
  state(): AsyncSnapshot<T>
  /** Explicitly allow a previous successful value while refreshing or failed. */
  latest(): T
  /** Restart with current inputs. */
  refresh(): void
  /** Permanently dispose this computation and cancel its transport. */
  dispose(): void
}

interface AsyncFlight<T> {
  generation: number
  controller: AbortController
  root: RootContext
  iterator?: AsyncIterator<T>
  next?: () => PromiseLike<IteratorResult<T>>
  iteratorDone: boolean
  iteratorReturned: boolean
  closed: boolean
}

/**
 * Explicit asynchronous computation. Only synchronous producer reads are tracked;
 * capture inputs before returning a Promise or entering an iterator continuation.
 * A root owns the node; outside a root, the caller must dispose it.
 */
export function createAsyncMemo<T>(
  produce: (context: AsyncContext<T>) => T | PromiseLike<T> | AsyncIterable<T>,
  options?: AsyncMemoOptions,
): AsyncMemo<T> {
  const state = new AsyncState<T>()
  const owner = getCurrentRoot()
  let active: AsyncFlight<T> | undefined
  let evaluating = false

  const returnIterator = (flight: AsyncFlight<T>) => {
    if (!flight.iterator || flight.iteratorDone || flight.iteratorReturned) return
    flight.iteratorReturned = true
    try {
      const result = flight.iterator.return?.()
      if (result) void Promise.resolve(result).catch(() => undefined)
    } catch {
      // Teardown cannot resurrect a superseded transport or strand its owner.
    }
  }

  const close = (flight: AsyncFlight<T> | undefined) => {
    if (!flight || flight.closed) return
    flight.closed = true
    untrack(() => {
      try {
        flight.controller.abort()
      } finally {
        try {
          returnIterator(flight)
        } finally {
          destroyRoot(flight.root)
        }
      }
    })
  }

  const current = (flight: AsyncFlight<T>) => active === flight && !flight.closed

  const waitForInput = (error: unknown, generation: number, rejection = false): boolean => {
    if (rejection || !isAsyncPending(error)) return false
    const retry = () => {
      const snapshot = state.snapshot
      if (snapshot.status !== 'disposed' && snapshot.generation === generation) {
        node.invalidate()
      }
    }
    void Promise.resolve(error).then(retry, retry)
    return true
  }

  const failInputs = (error: unknown, rejection = false): AsyncSnapshot<T> => {
    if (state.snapshot.status === 'disposed') return state.snapshot
    const token = state.begin()
    const flight = active
    active = undefined
    try {
      close(flight)
    } catch (cleanupError) {
      error = cleanupError
    }
    if (!waitForInput(error, token.generation, rejection)) state.reject(token.generation, error)
    return state.snapshot
  }

  const settle = (flight: AsyncFlight<T>, change: () => boolean) => {
    if (!current(flight)) return
    // A source can change before its scheduled flush or before a Promise job.
    // Pull the actual input graph before accepting this generation's result.
    try {
      untrack(node.read)
    } catch (error) {
      if (current(flight)) node.publish(failInputs(error))
      return
    }
    if (current(flight) && change()) node.publish(state.snapshot)
  }

  const driveIterator = async (flight: AsyncFlight<T>) => {
    try {
      while (current(flight)) {
        const result = await untrack(flight.next!)
        if (!current(flight)) return
        if (result === null || typeof result !== 'object')
          throw new TypeError('[fict] Invalid async iterator result.')
        if (result.done) {
          flight.iteratorDone = true
          settle(flight, () => state.complete(flight.generation))
          return
        }
        settle(flight, () => state.publish(flight.generation, result.value, false))
      }
    } catch (error) {
      settle(flight, () => state.reject(flight.generation, error))
      untrack(() => returnIterator(flight))
    }
  }

  const evaluate = (): AsyncSnapshot<T> => {
    if (state.snapshot.status === 'disposed') return state.snapshot
    const previous = state.snapshot
    const token = state.begin()
    const old = active
    const flight: AsyncFlight<T> = {
      generation: token.generation,
      controller: new AbortController(),
      root: createRootContext(owner),
      iteratorDone: false,
      iteratorReturned: false,
      closed: false,
    }
    active = flight
    evaluating = true
    try {
      close(old)
      const context: AsyncContext<T> = previous.hasValue
        ? { signal: flight.controller.signal, hasValue: true, previous: previous.value }
        : { signal: flight.controller.signal, hasValue: false, previous: undefined }
      const result = withRootContext(flight.root, () => produce(context))
      const asynchronous =
        result !== null && (typeof result === 'object' || typeof result === 'function')
      const iteratorMethod = asynchronous
        ? (result as AsyncIterable<T>)[Symbol.asyncIterator]
        : undefined
      const then =
        asynchronous && typeof iteratorMethod !== 'function'
          ? (result as PromiseLike<T>).then
          : undefined
      if (typeof iteratorMethod === 'function') {
        flight.iterator = untrack(() => iteratorMethod.call(result))
        const next = flight.iterator.next
        if (typeof next !== 'function')
          throw new TypeError('[fict] Async iterator has no next method.')
        flight.next = next.bind(flight.iterator)
        if (current(flight)) void driveIterator(flight)
        else untrack(() => returnIterator(flight))
      } else if (typeof then === 'function') {
        // Always install both handlers, even if the producer disposed its owner.
        // Capture `then` once, with its receiver, and assimilate it in a job.
        const promise = new Promise<T>((resolve, reject) => {
          void Promise.resolve()
            .then(() => {
              then.call(result, resolve, reject)
            })
            .catch(reject)
        })
        void promise.then(
          value => settle(flight, () => state.publish(flight.generation, value)),
          error => settle(flight, () => state.reject(flight.generation, error)),
        )
      } else {
        state.publish(flight.generation, result as T)
      }
    } catch (error) {
      if (!waitForInput(error, flight.generation, isAsyncRejection(error)))
        state.reject(flight.generation, error)
      untrack(() => returnIterator(flight))
    } finally {
      evaluating = false
    }
    return state.snapshot
  }

  const node = createAsyncGraphNode(
    evaluate,
    () => {
      state.dispose()
      const flight = active
      active = undefined
      close(flight)
      return state.snapshot
    },
    failInputs,
    options,
  )
  const readState = () => {
    if (evaluating)
      throw new Error('[fict] An async computation cannot read itself while producing.')
    return state.snapshot.status === 'disposed' ? state.snapshot : node.read()
  }
  const accessor = (() => {
    const snapshot = readState()
    registerAsyncRead(accessor)
    if (snapshot.status === 'errored') registerAsyncRejection(snapshot.error)
    return readAsyncSnapshot(snapshot)
  }) as AsyncMemo<T>
  accessor.state = readState
  accessor.latest = () => {
    const snapshot = readState()
    if (snapshot.hasValue) return snapshot.value
    registerAsyncRead(accessor.latest)
    if (snapshot.status === 'errored') registerAsyncRejection(snapshot.error)
    return readAsyncSnapshot(snapshot)
  }
  accessor.refresh = () => {
    if (state.snapshot.status === 'disposed') throw new AsyncDisposedError()
    if (evaluating)
      throw new Error('[fict] An async computation cannot refresh itself while producing.')
    node.invalidate()
    untrack(node.read)
  }
  accessor.dispose = node.dispose
  Object.defineProperty(accessor, Symbol.for('fict:computed'), { value: true })
  return accessor
}
