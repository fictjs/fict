/** Shared readiness protocol for graph computations and data-policy adapters. */
const ASYNC_PENDING = Symbol.for('fict:async-pending')

export interface AsyncPending extends PromiseLike<void> {
  readonly [ASYNC_PENDING]: true
  readonly generation: number
}

type AsyncValue<T> =
  | { readonly hasValue: false; readonly value: undefined }
  | { readonly hasValue: true; readonly value: T }

/** A value of `undefined` and a rejection of `undefined` are both representable. */
export type AsyncSnapshot<T> = { readonly generation: number } & (
  | {
      readonly status: 'uninitialized'
      readonly hasValue: false
      readonly value: undefined
      readonly error: undefined
      readonly pending: undefined
    }
  | {
      readonly status: 'pending'
      readonly hasValue: false
      readonly value: undefined
      readonly error: undefined
      readonly pending: AsyncPending
    }
  | {
      readonly status: 'ready'
      readonly hasValue: true
      readonly value: T
      readonly error: undefined
      readonly pending: undefined
    }
  | {
      readonly status: 'refreshing'
      readonly hasValue: true
      readonly value: T
      readonly error: undefined
      readonly pending: AsyncPending
    }
  | ({
      readonly status: 'errored'
      readonly error: unknown
      readonly pending: undefined
    } & AsyncValue<T>)
  | ({
      readonly status: 'disposed'
      readonly error: undefined
      readonly pending: undefined
    } & AsyncValue<T>)
)

export class AsyncDisposedError extends Error {
  constructor() {
    super('[fict] Cannot read or restart a disposed async computation.')
    this.name = 'AsyncDisposedError'
  }
}

export class AsyncEmptyError extends Error {
  constructor() {
    super('[fict] An async iterable completed without yielding a value.')
    this.name = 'AsyncEmptyError'
  }
}

export function isAsyncPending(value: unknown): value is AsyncPending {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false
  try {
    return (value as Partial<AsyncPending>)[ASYNC_PENDING] === true
  } catch {
    // An arbitrary thrown value can be a revoked Proxy or have a throwing
    // property getter. Classifying it must not replace the original failure.
    return false
  }
}

interface Flight {
  generation: number
  token: AsyncPending
  wake: () => void
  yielded: boolean
}

export function readAsyncSnapshot<T>(snapshot: AsyncSnapshot<T>): T {
  switch (snapshot.status) {
    case 'ready':
      return snapshot.value
    case 'pending':
    case 'refreshing':
      throw snapshot.pending
    case 'errored':
      throw snapshot.error
    case 'disposed':
      throw new AsyncDisposedError()
    default:
      throw new Error('[fict] Async computation has not started.')
  }
}

/**
 * Contains no signals, effects, cache policy, or host callbacks. A graph node owns
 * this state and publishes changed snapshots through its existing subscriptions.
 * Transport cancellation is separate: even a transport ignoring abort cannot
 * commit a superseded generation through this protocol.
 */
export class AsyncState<T> {
  private current: AsyncSnapshot<T> = Object.freeze({
    generation: 0,
    status: 'uninitialized',
    hasValue: false,
    value: undefined,
    error: undefined,
    pending: undefined,
  })
  private flight: Flight | undefined

  get snapshot(): AsyncSnapshot<T> {
    return this.current
  }

  begin(): AsyncPending {
    if (this.current.status === 'disposed') throw new AsyncDisposedError()
    this.flight?.wake()
    const generation = this.current.generation + 1
    let wake!: () => void
    // Tokens are wakeups, never rejected promises. The retried read throws the
    // original failure. Superseding or disposing also releases old waiters.
    const promise = new Promise<void>(resolve => {
      wake = resolve
    })
    const token: AsyncPending = Object.freeze({
      [ASYNC_PENDING]: true as const,
      generation,
      then: promise.then.bind(promise),
    })
    this.flight = { generation, token, wake, yielded: false }
    this.current = Object.freeze(
      this.current.hasValue
        ? {
            generation,
            status: 'refreshing',
            hasValue: true,
            value: this.current.value,
            error: undefined,
            pending: token,
          }
        : {
            generation,
            status: 'pending',
            hasValue: false,
            value: undefined,
            error: undefined,
            pending: token,
          },
    )
    return token
  }

  /** `final: false` publishes an iterator yield while retaining that generation. */
  publish(generation: number, value: T, final = true): boolean {
    const flight = this.flight
    if (!flight || flight.generation !== generation) return false
    this.current = Object.freeze({
      generation,
      status: 'ready',
      hasValue: true,
      value,
      error: undefined,
      pending: undefined,
    })
    flight.yielded = true
    flight.wake()
    if (final) this.flight = undefined
    return true
  }

  reject(generation: number, error: unknown): boolean {
    const flight = this.flight
    if (!flight || flight.generation !== generation) return false
    this.current = Object.freeze({ ...this.current, status: 'errored', error, pending: undefined })
    this.flight = undefined
    flight.wake()
    return true
  }

  /** An iterator's return value is not a yield, including during refresh. */
  complete(generation: number): boolean {
    const flight = this.flight
    if (!flight || flight.generation !== generation) return false
    if (!flight.yielded) return this.reject(generation, new AsyncEmptyError())
    this.flight = undefined
    flight.wake()
    return true
  }

  dispose(): boolean {
    if (this.current.status === 'disposed') return false
    const flight = this.flight
    this.flight = undefined
    this.current = Object.freeze({
      ...this.current,
      status: 'disposed',
      error: undefined,
      pending: undefined,
    })
    flight?.wake()
    return true
  }

  read(): T {
    return readAsyncSnapshot(this.current)
  }

  /** Explicit stale reads never turn an absent value into an invented value. */
  latest(): T {
    return this.current.hasValue ? this.current.value : this.read()
  }
}
