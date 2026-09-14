import { afterEach, expect, it } from 'vitest'
import { createAsyncMemo } from '../src/async-memo'
import { AsyncState, isAsyncPending } from '../src/async-state'
import { createEffect } from '../src/effect'
import { createRoot, registerErrorHandler, registerSuspenseHandler } from '../src/lifecycle'
import { createMemo } from '../src/memo'
import { __resetReactiveState, flush, signal } from '../src/signal'

const disposers: (() => void)[] = []
afterEach(() => {
  while (disposers.length) disposers.pop()!()
  __resetReactiveState()
})
const drain = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  flush()
}
const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

it.each(['direct', 'memo', 'chain'])(
  'ordinary effect catches pending and arbitrary rejection values through %s reads',
  async kind => {
    const reasons: unknown[] = [
      undefined,
      'failure',
      Promise.resolve('error value'),
      new AsyncState().begin(),
    ]
    for (const reason of reasons) {
      const key = signal(0)
      const request = deferred<string>()
      const events: unknown[] = []
      const errors: unknown[] = []
      const scope = createRoot(() => {
        registerErrorHandler(error => {
          errors.push(error)
          return true
        })
        const data = createAsyncMemo(() => (key() ? request.promise : 'ready'))
        const derived = kind === 'direct' ? data : createMemo(() => data())
        const read = kind === 'chain' ? createMemo(() => derived()) : derived
        createEffect(() => {
          try {
            events.push(read())
          } catch (error) {
            events.push(error)
          }
        })
        return data
      })
      disposers.push(scope.dispose)
      expect(events).toEqual(['ready'])
      key(1)
      await drain()
      expect(events).toHaveLength(2)
      expect(events[1]).toBe(scope.value.state().pending)
      request.reject(reason)
      await drain()
      expect(events).toHaveLength(3)
      expect(events[2]).toBe(reason)
      expect(errors).toEqual([])
      scope.dispose()
    }
  },
)

it('derived try/catch runs when dependency checking encounters unavailable upstream work', async () => {
  const key = signal(0)
  const request = deferred<string>()
  const events: string[] = []
  const scope = createRoot(() => {
    const data = createAsyncMemo(() => (key() ? request.promise : 'ready'))
    const upstream = createMemo(() => data())
    const local = createMemo(() => {
      try {
        return upstream()
      } catch (error) {
        return isAsyncPending(error) ? 'pending' : 'failed'
      }
    })
    createEffect(() => {
      events.push(local())
    })
  })
  disposers.push(scope.dispose)
  key(1)
  await drain()
  expect(events).toEqual(['ready', 'pending'])
  request.reject('failure')
  await drain()
  expect(events).toEqual(['ready', 'pending', 'failed'])
})

it('ordinary effects follow current branches and clean up before each attempt', async () => {
  const key = signal(0)
  const shown = signal(true)
  const request = deferred<string>()
  const events: string[] = []
  const scope = createRoot(() => {
    registerSuspenseHandler(token => isAsyncPending(token))
    const data = createAsyncMemo(() => (key() ? request.promise : 'ready'))
    const upstream = createMemo(() => data())
    createEffect(() => {
      events.push('attempt')
      const value = shown() ? upstream() : 'off'
      events.push(value)
      return () => {
        events.push(`cleanup:${value}`)
      }
    })
  })
  disposers.push(scope.dispose)
  key(1)
  await drain()
  expect(events).toEqual(['attempt', 'ready', 'cleanup:ready', 'attempt'])
  shown(false)
  await drain()
  expect(events).toEqual(['attempt', 'ready', 'cleanup:ready', 'attempt', 'attempt', 'off'])
  request.resolve('obsolete')
  await drain()
  expect(events).toHaveLength(6)
  scope.dispose()
  expect(events[events.length - 1]).toBe('cleanup:off')
})

it.each([false, true])(
  'recovers through a local synchronous catch (direct invalidation: %s)',
  direct => {
    const key = signal(0)
    const other = signal(0)
    const events: string[] = []
    const scope = createRoot(() => {
      const upstream = createMemo(() => {
        if (key()) throw new Error('unavailable')
        return 'ready'
      })
      const local = createMemo(() => {
        other()
        try {
          return upstream()
        } catch {
          return 'fallback'
        }
      })
      createEffect(() => {
        events.push(local())
      })
    })
    disposers.push(scope.dispose)
    key(1)
    if (direct) other(1)
    flush()
    expect(events).toEqual(['ready', 'fallback'])
    key(0)
    flush()
    expect(events).toEqual(['ready', 'fallback', 'ready'])
  },
)

it('propagates cached failures through a deep chain without skipping ancestor catches', async () => {
  const key = signal(0)
  const request = deferred<number>()
  const events: unknown[] = []
  const scope = createRoot(() => {
    const data = createAsyncMemo(() => (key() ? request.promise : 1))
    let read: () => number = data
    for (let i = 0; i < 1500; i++) {
      const input = read
      read = createMemo(() => input())
      read()
    }
    const result = createMemo(() => {
      try {
        return read()
      } catch (error) {
        return error
      }
    })
    createEffect(() => {
      events.push(result())
    })
    return data
  })
  disposers.push(scope.dispose)
  key(1)
  await drain()
  expect(events).toEqual([1, scope.value.state().pending])
  request.resolve(1)
  await drain()
  expect(events).toEqual([1, events[1], 1])
})
