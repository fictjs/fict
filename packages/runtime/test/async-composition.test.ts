import { afterEach, describe, expect, it } from 'vitest'

import { createAsyncMemo } from '../src/async-memo'
import { createAsyncEffect } from '../src/async-effect'
import { AsyncState, isAsyncPending } from '../src/async-state'
import { createEffect } from '../src/effect'
import {
  createRoot,
  onCleanup,
  registerErrorHandler,
  registerSuspenseHandler,
} from '../src/lifecycle'
import { createMemo } from '../src/memo'
import { __resetReactiveState, flush, signal, untrack } from '../src/signal'

const disposers: (() => void)[] = []
afterEach(() => {
  while (disposers.length) disposers.pop()!()
  __resetReactiveState()
})
const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const drain = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
  flush()
}
const root = <T>(fn: () => T) => {
  const scope = createRoot(() => {
    registerSuspenseHandler(token => isAsyncPending(token))
    return fn()
  })
  disposers.push(scope.dispose)
  return scope.value
}

describe('async readiness through synchronous computations', () => {
  it('retains an initially suspended dependency chain until the effect can run', async () => {
    const request = deferred<number>()
    const values: number[] = []
    root(() => {
      const data = createAsyncMemo(() => request.promise)
      const doubled = createMemo(() => data() * 2)
      const label = createMemo(() => doubled() + 1)
      createEffect(() => {
        values.push(label())
      })
    })
    expect(values).toEqual([])
    request.resolve(4)
    await drain()
    expect(values).toEqual([9])
  })

  it('prepared effects preserve committed cleanup across refresh through a chain and recover', async () => {
    const id = signal(1)
    const request = deferred<number>()
    const events: string[] = []
    root(() => {
      const data = createAsyncMemo(() => (id() === 1 ? 10 : request.promise))
      const doubled = createMemo(() => data() * 2)
      const label = createMemo(() => doubled() + 1)
      createAsyncEffect(label, value => {
        events.push(`run:${value}`)
        return () => {
          events.push(`cleanup:${value}`)
        }
      })
    })
    id(2)
    flush()
    expect(events).toEqual(['run:21'])
    request.resolve(20)
    await drain()
    expect(events).toEqual(['run:21', 'cleanup:21', 'run:41'])
  })

  it('prepares direct async consumers before cleanup, including dirty effects', async () => {
    const id = signal(1)
    const side = signal('first')
    const request = deferred<number>()
    const events: string[] = []
    root(() => {
      const data = createAsyncMemo(() => (id() === 1 ? 10 : request.promise))
      createAsyncEffect(
        () => `${side()}:${data()}`,
        value => {
          events.push(`run:${value}`)
          return () => {
            events.push(`cleanup:${value}`)
          }
        },
      )
    })
    id(2)
    side('second')
    flush()
    expect(events).toEqual(['run:first:10'])
    request.resolve(20)
    await drain()
    expect(events).toEqual(['run:first:10', 'cleanup:first:10', 'run:second:20'])
  })

  it('commits one coherent diamond result after an asynchronous refresh', async () => {
    const id = signal(1)
    const request = deferred<number>()
    const values: [number, number][] = []
    root(() => {
      const data = createAsyncMemo(() => (id() === 1 ? 10 : request.promise))
      const left = createMemo(() => data() + 1)
      const right = createMemo(() => data() + 2)
      const pair = createMemo(() => [left(), right()] as [number, number])
      createEffect(() => {
        values.push(pair())
      })
    })
    id(2)
    flush()
    expect(values).toEqual([[11, 12]])
    request.resolve(20)
    await drain()
    expect(values).toEqual([
      [11, 12],
      [21, 22],
    ])
  })

  it('allows status and stale-value consumers to observe refresh immediately', async () => {
    const id = signal(1)
    const request = deferred<number>()
    const values: string[] = []
    root(() => {
      const data = createAsyncMemo(() => (id() === 1 ? 10 : request.promise))
      createEffect(() => {
        values.push(`${data.state().status}:${data.latest()}`)
      })
    })
    id(2)
    flush()
    expect(values).toEqual(['ready:10', 'refreshing:10'])
    request.resolve(20)
    await drain()
    expect(values).toEqual(['ready:10', 'refreshing:10', 'ready:20'])
  })

  it('preserves a user-authored pending fallback inside a synchronous memo', async () => {
    const request = deferred<number>()
    const values: (number | string)[] = []
    root(() => {
      const data = createAsyncMemo(() => request.promise)
      const fallback = createMemo(() => {
        try {
          return data()
        } catch (error) {
          if (isAsyncPending(error)) return 'waiting'
          throw error
        }
      })
      createEffect(() => {
        values.push(fallback())
      })
    })
    expect(values).toEqual(['waiting'])
    request.resolve(2)
    await drain()
    expect(values).toEqual(['waiting', 2])
  })

  it('propagates exact failures through a chain without stranding independent roots', async () => {
    const id = signal(1)
    const request = deferred<number>()
    const siblingRequest = deferred<number>()
    const errors: unknown[] = []
    const values: number[] = []
    root(() => {
      registerErrorHandler(error => {
        errors.push(error)
        return true
      })
      const data = createAsyncMemo(() => (id() === 1 ? request.promise : 7))
      const child = createMemo(() => data() * 2)
      createEffect(() => {
        values.push(child())
      })
    })
    const sibling: number[] = []
    root(() => {
      const data = createAsyncMemo(() => siblingRequest.promise)
      const child = createMemo(() => data() * 3)
      createEffect(() => {
        sibling.push(child())
      })
    })
    request.reject(null)
    siblingRequest.resolve(3)
    await drain()
    expect(errors).toEqual([null])
    expect(sibling).toEqual([9])
    id(2)
    await drain()
    expect(values).toEqual([14])
  })

  it('keeps downstream async producers pending until their synchronous inputs are current', async () => {
    const request = deferred<number>()
    const states: string[] = []
    const values: number[] = []
    root(() => {
      const first = createAsyncMemo(() => request.promise)
      const middle = createMemo(() => first() * 2)
      const last = createAsyncMemo(() => Promise.resolve(middle() + 1))
      createEffect(() => {
        states.push(last.state().status)
      })
      createEffect(() => {
        values.push(last())
      })
    })
    expect(states).toEqual(['pending'])
    request.resolve(3)
    await drain()
    expect(values).toEqual([7])
    expect(states[states.length - 1]).toBe('ready')
  })

  it.each([undefined, null, NaN, Promise.resolve('reason'), new AsyncState().begin()])(
    'routes arbitrary async rejection identity to errors, including thenables: %s',
    async error => {
      const request = deferred<number>()
      const errors: unknown[] = []
      const suspended: unknown[] = []
      const scope = createRoot(() => {
        registerSuspenseHandler(token => {
          suspended.push(token)
          return true
        })
        registerErrorHandler(reason => {
          errors.push(reason)
          return true
        })
        const data = createAsyncMemo(() => request.promise)
        const middle = createMemo(() => data() + 1)
        const last = createMemo(() => middle() * 2)
        createEffect(() => {
          last()
        })
      })
      disposers.push(scope.dispose)
      expect(suspended).toHaveLength(1)
      request.reject(error)
      await drain()
      expect(errors).toHaveLength(1)
      expect(Object.is(errors[0], error)).toBe(true)
      expect(suspended).toHaveLength(1)
    },
  )

  it('prepares newly selected async branches before cleanup or any commit writes', async () => {
    const choose = signal(false)
    const request = deferred<string>()
    const events: string[] = []
    root(() => {
      const data = createAsyncMemo(() => request.promise)
      createAsyncEffect(
        () => (choose() ? data() : 'initial'),
        value => {
          events.push(`commit:${value}`)
          onCleanup(() => {
            events.push(`cleanup:${value}`)
          })
        },
      )
    })
    choose(true)
    flush()
    expect(events).toEqual(['commit:initial'])
    request.resolve('next')
    await drain()
    expect(events).toEqual(['commit:initial', 'cleanup:initial', 'commit:next'])
  })

  it('can leave a pending branch and commits without waiting for its abandoned inputs', async () => {
    const choose = signal(true)
    const request = deferred<string>()
    const events: string[] = []
    root(() => {
      const data = createAsyncMemo(() => request.promise)
      createAsyncEffect(
        () => (choose() ? data() : 'other'),
        value => {
          events.push(value)
        },
      )
    })
    expect(events).toEqual([])
    choose(false)
    flush()
    expect(events).toEqual(['other'])
    request.resolve('late')
    await drain()
    expect(events).toEqual(['other'])
  })

  it('owns nested commit work until replacement and detaches it on explicit disposal', () => {
    const input = signal(1)
    const side = signal(1)
    const events: string[] = []
    const stop = root(() =>
      createAsyncEffect(input, value => {
        createEffect(() => {
          events.push(`nested:${value}:${side()}`)
        })
        return () => {
          events.push(`cleanup:${value}`)
        }
      }),
    )
    input(2)
    flush()
    side(2)
    flush()
    stop()
    input(3)
    side(3)
    flush()
    expect(events).toEqual(['nested:1:1', 'cleanup:1', 'nested:2:1', 'nested:2:2', 'cleanup:2'])
  })

  it('preserves rejection identity through an explicitly untracked memo read', () => {
    const reason = Promise.resolve('failure')
    const errors: unknown[] = []
    const scope = createRoot(() => {
      registerErrorHandler(error => {
        errors.push(error)
        return true
      })
      registerSuspenseHandler(() => {
        throw new Error('must not suspend on a rejection')
      })
      const data = createAsyncMemo(() => {
        throw reason
      })
      const derived = createMemo(() => untrack(data))
      createEffect(() => {
        derived()
      })
    })
    disposers.push(scope.dispose)
    expect(errors).toEqual([reason])
  })
})
