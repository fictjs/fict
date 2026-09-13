import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'

import { createAsyncMemo, type AsyncMemo } from '../src/async-memo'
import { AsyncDisposedError, AsyncEmptyError } from '../src/async-state'
import { createEffect } from '../src/effect'
import { createRoot, onCleanup } from '../src/lifecycle'
import { createMemo } from '../src/memo'
import {
  __resetReactiveState,
  effect,
  flush,
  getActiveSub,
  isComputed,
  signal,
  type ReactiveNode,
} from '../src/signal'

const disposers: (() => void)[] = []
afterEach(() => {
  while (disposers.length) disposers.pop()!()
  __resetReactiveState()
})
const own = <T>(memo: AsyncMemo<T>): AsyncMemo<T> => {
  disposers.push(memo.dispose)
  return memo
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
const drain = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
  flush()
}

describe('explicit async computed node', () => {
  it('owns one input graph, starts lazily, and publishes readiness through that node', async () => {
    const input = signal(1)
    const request = deferred<number>()
    let producerNode: ReactiveNode | undefined
    let calls = 0
    const memo = own(
      createAsyncMemo(() => {
        calls++
        producerNode = getActiveSub()
        input()
        return request.promise
      }),
    )
    expectTypeOf(memo).toEqualTypeOf<AsyncMemo<number>>()
    expect(calls).toBe(0)
    expect(isComputed(memo)).toBe(true)
    const statuses: string[] = []
    const stop = effect(() => {
      statuses.push(memo.state().status)
    })
    disposers.push(stop)
    expect(calls).toBe(1)
    expect(producerNode).toHaveProperty('getter')
    expect(producerNode).not.toHaveProperty('fn')
    expect(producerNode!.deps?.nextDep).toBeUndefined()
    expect(producerNode!.deps?.dep).toHaveProperty('currentValue', 1)
    request.resolve(10)
    await drain()
    expect(statuses).toEqual(['pending', 'ready'])
    expect(memo()).toBe(10)
    expect(calls).toBe(1)
    memo.dispose()
    flush()
    expect(statuses).toEqual(['pending', 'ready', 'disposed'])
    expect(producerNode!.deps).toBeUndefined()
    expect(producerNode!.subs).toBeUndefined()
  })

  it('checks changed inputs before a completion that precedes the scheduled flush', async () => {
    const input = signal(1)
    const requests: ReturnType<typeof deferred<number>>[] = []
    const aborts: AbortSignal[] = []
    const starts: number[] = []
    const memo = own(
      createAsyncMemo<number>(({ signal: abort }) => {
        starts.push(input())
        aborts.push(abort)
        const request = deferred<number>()
        requests.push(request)
        return request.promise
      }),
    )
    memo.state()
    await drain() // Install the captured then handler.
    requests[0]!.resolve(111)
    input(2)
    await drain()
    expect(starts).toEqual([1, 2])
    expect(aborts[0]!.aborted).toBe(true)
    expect(memo.state()).toMatchObject({ status: 'pending', hasValue: false })
    requests[1]!.resolve(222)
    await drain()
    expect(memo()).toBe(222)
  })

  it('tracks conditional inputs and preserves current flights when input equality suppresses work', async () => {
    const branch = signal(true)
    const left = signal(1)
    const right = signal(5)
    const values: number[] = []
    const memo = own(
      createAsyncMemo(() => {
        const value = branch() ? left() : right()
        values.push(value)
        return Promise.resolve(value)
      }),
    )
    memo.state()
    await drain()
    left(2)
    left(1)
    expect(memo()).toBe(1)
    expect(values).toEqual([1])
    branch(false)
    memo.state()
    await drain()
    expect(memo()).toBe(5)
    left(9)
    expect(memo()).toBe(5)
    expect(values).toEqual([1, 5])
  })

  it('retains a pending computation when a temporary observer unsubscribes', async () => {
    const request = deferred<number>()
    const input = signal(1)
    const produce = vi.fn(() => {
      input()
      return request.promise
    })
    const memo = own(createAsyncMemo(produce))
    const stop = effect(() => {
      memo.state()
    })
    stop()
    request.resolve(3)
    await drain()
    expect(memo()).toBe(3)
    expect(produce).toHaveBeenCalledTimes(1)
  })

  it('invalidates an activated flight even when only an imperative token waiter remains', async () => {
    const input = signal(1)
    const aborts: AbortSignal[] = []
    const produce = vi.fn((context: { signal: AbortSignal }) => {
      input()
      aborts.push(context.signal)
      return new Promise<number>(() => {})
    })
    const memo = own(createAsyncMemo(produce))
    const token = memo.state().pending!
    input(2)
    await drain()
    expect(aborts[0]!.aborted).toBe(true)
    expect(produce).toHaveBeenCalledTimes(2)
    await token
    expect(memo.state().pending).not.toBe(token)
  })

  it('rejects recursive reads and refreshes without starting an infinite producer loop', () => {
    let memo!: AsyncMemo<number>
    memo = own(createAsyncMemo(() => memo()))
    expect(memo.state().error).toHaveProperty(
      'message',
      '[fict] An async computation cannot read itself while producing.',
    )
    let refreshing!: AsyncMemo<number>
    refreshing = own(
      createAsyncMemo(() => {
        refreshing.refresh()
        return 1
      }),
    )
    expect(refreshing.state().error).toHaveProperty(
      'message',
      '[fict] An async computation cannot refresh itself while producing.',
    )
  })

  it('detaches the graph even when a generation cleanup throws during disposal', () => {
    const source = signal(1)
    let node: ReactiveNode | undefined
    const failure = new Error('cleanup failed')
    const memo = own(
      createAsyncMemo(() => {
        node = getActiveSub()
        onCleanup(() => {
          throw failure
        })
        return source()
      }),
    )
    expect(memo()).toBe(1)
    expect(() => memo.dispose()).toThrow(failure)
    expect(node!.deps).toBeUndefined()
    expect(node!.subs).toBeUndefined()
    expect(memo.state().status).toBe('disposed')
  })

  it('captures then once, preserves its receiver, and ignores repeated settlements', async () => {
    let gets = 0
    let calls = 0
    const thenable = {
      get then() {
        gets++
        return function (
          this: unknown,
          resolve: (value: number) => void,
          reject: (error: unknown) => void,
        ) {
          expect(this).toBe(thenable)
          calls++
          resolve(3)
          reject('late')
          resolve(4)
        }
      },
    }
    const memo = own(createAsyncMemo<number>(() => thenable as unknown as PromiseLike<number>))
    expect(memo.state().status).toBe('pending')
    expect(calls).toBe(0)
    await drain()
    expect(memo()).toBe(3)
    expect(gets).toBe(1)
    expect(calls).toBe(1)
  })

  it('preserves producer errors, throwing then getters, and explicit retries', async () => {
    const input = signal(0)
    const failure = { error: 'failed' }
    const memo = own(
      createAsyncMemo<number>(() => {
        const mode = input()
        if (!mode) throw failure
        if (mode === 1)
          return {
            get then() {
              throw null
            },
          } as unknown as PromiseLike<number>
        return Promise.resolve(8)
      }),
    )
    expect(memo.state()).toMatchObject({ status: 'errored', error: failure })
    input(1)
    expect(memo.state()).toMatchObject({ status: 'errored', error: null })
    input(2)
    memo.refresh()
    await drain()
    expect(memo()).toBe(8)
  })

  it('owns per-generation cleanup and supplies the prior successful value', async () => {
    const events: string[] = []
    let generation = 0
    const memo = own(
      createAsyncMemo<number | undefined>(context => {
        const id = ++generation
        events.push(`start:${id}:${context.hasValue}:${context.previous}`)
        onCleanup(() => {
          events.push(`cleanup:${id}`)
        })
        return Promise.resolve(id === 1 ? undefined : id)
      }),
    )
    memo.state()
    await drain()
    memo.refresh()
    expect(memo.latest()).toBeUndefined()
    await drain()
    expect(memo()).toBe(2)
    memo.dispose()
    expect(events).toEqual([
      'start:1:false:undefined',
      'cleanup:1',
      'start:2:true:undefined',
      'cleanup:2',
    ])
  })

  it('root disposal aborts, wakes readers, detaches inputs, and rejects late results', async () => {
    const request = deferred<number>()
    let abort!: AbortSignal
    const root = createRoot(() =>
      createAsyncMemo<number>(context => {
        abort = context.signal
        return request.promise
      }),
    )
    const pending = root.value.state().pending!
    root.dispose()
    await pending
    expect(abort.aborted).toBe(true)
    request.reject(new Error('late rejection'))
    await drain()
    expect(root.value.state().status).toBe('disposed')
    expect(() => root.value()).toThrow(AsyncDisposedError)
    expect(() => root.value.refresh()).toThrow(AsyncDisposedError)
  })

  it('does not start a node disposed before its first read', () => {
    const produce = vi.fn(() => Promise.resolve(1))
    const memo = createAsyncMemo(produce)
    memo.dispose()
    expect(memo.state().status).toBe('disposed')
    expect(() => memo()).toThrow(AsyncDisposedError)
    expect(produce).not.toHaveBeenCalled()
  })

  it('handles owner disposal from inside a producer and consumes its returned rejection', async () => {
    const request = deferred<number>()
    const root = createRoot(() =>
      createAsyncMemo<number>(() => {
        root.dispose()
        return request.promise
      }),
    )
    expect(root.value.state().status).toBe('disposed')
    request.reject('disposed during production')
    await drain()
    expect(root.value.state().status).toBe('disposed')
  })

  it('reads committed snapshots during effect cleanup', () => {
    const source = signal(1)
    const memo = own(createAsyncMemo(() => source() * 2))
    const values: string[] = []
    const stop = createEffect(() => {
      values.push(`run:${memo()}`)
      return () => {
        values.push(`cleanup:${memo()}`)
      }
    })
    source(2)
    flush()
    expect(values).toEqual(['run:2', 'cleanup:2', 'run:4'])
    stop()
  })

  it('handles a synchronous input memo throwing before a transport can commit', async () => {
    const source = signal(false)
    const failure = new Error('input failed')
    const input = createMemo(() => {
      if (source()) throw failure
      return 1
    })
    const request = deferred<number>()
    const memo = own(
      createAsyncMemo(() => {
        input()
        return request.promise
      }),
    )
    memo.state()
    source(true)
    request.resolve(1)
    await drain()
    expect(memo.state()).toMatchObject({ status: 'errored', error: failure })
  })
})

describe('async iterable graph nodes', () => {
  it('preserves the previous stream value for cleanup when publication starts a flush', async () => {
    const requests: ReturnType<typeof deferred<IteratorResult<number>>>[] = []
    const memo = own(
      createAsyncMemo<number>(() => ({
        [Symbol.asyncIterator]() {
          return {
            next() {
              const request = deferred<IteratorResult<number>>()
              requests.push(request)
              return request.promise
            },
          }
        },
      })),
    )
    memo.state()
    requests[0]!.resolve({ done: false, value: 1 })
    await drain()
    const events: string[] = []
    const stop = createEffect(() => {
      events.push(`run:${memo()}`)
      return () => {
        events.push(`cleanup:${memo()}`)
      }
    })
    disposers.push(stop)
    requests[1]!.resolve({ done: false, value: 2 })
    await drain()
    expect(events).toEqual(['run:1', 'cleanup:1', 'run:2'])
  })

  it('tracks producer inputs, streams yields, and cancels next exactly once on replacement', async () => {
    const input = signal(1)
    const requests: ReturnType<typeof deferred<IteratorResult<number>>>[] = []
    const returns: number[] = []
    const memo = own(
      createAsyncMemo<number>(() => {
        const id = input()
        const iterator: AsyncIterator<number> = {
          next() {
            const request = deferred<IteratorResult<number>>()
            requests.push(request)
            return request.promise
          },
          return() {
            returns.push(id)
            return Promise.reject(new Error('ignored teardown failure'))
          },
        }
        return {
          [Symbol.asyncIterator]() {
            return iterator
          },
        }
      }),
    )
    const token = memo.state().pending!
    requests[0]!.resolve({ done: false, value: 10 })
    await token
    await drain()
    expect(memo()).toBe(10)
    requests[1]!.resolve({ done: false, value: 11 })
    await drain()
    expect(memo()).toBe(11)
    input(2)
    expect(memo.state().status).toBe('refreshing')
    expect(memo.latest()).toBe(11)
    expect(returns).toEqual([1])
    requests[2]!.reject('stale iteration failure')
    await drain()
    requests[3]!.resolve({ done: false, value: 20 })
    await drain()
    expect(memo()).toBe(20)
    memo.dispose()
    await drain()
    expect(returns).toEqual([1, 2])
  })

  it('keeps a completed stream value and rejects an empty refreshed stream', async () => {
    let empty = false
    const memo = own(
      createAsyncMemo<number>(() =>
        (async function* () {
          if (!empty) yield 9
          return 999
        })(),
      ),
    )
    memo.state()
    await drain()
    expect(memo()).toBe(9)
    empty = true
    memo.refresh()
    await drain()
    expect(memo.state().error).toBeInstanceOf(AsyncEmptyError)
    expect(memo.latest()).toBe(9)
  })

  it('reads iterator methods once and rejects malformed next results', async () => {
    let factories = 0
    let nextGets = 0
    const returned = vi.fn(() => Promise.resolve({ done: true, value: undefined }))
    const iterator = {
      get next() {
        nextGets++
        return () => Promise.resolve(5)
      },
      return: returned,
    }
    const iterable = {
      get [Symbol.asyncIterator]() {
        factories++
        return function (this: unknown) {
          expect(this).toBe(iterable)
          return iterator
        }
      },
    }
    const memo = own(createAsyncMemo<number>(() => iterable as unknown as AsyncIterable<number>))
    memo.state()
    await drain()
    expect(memo.state().error).toBeInstanceOf(TypeError)
    expect(factories).toBe(1)
    expect(nextGets).toBe(1)
    expect(returned).toHaveBeenCalledTimes(1)
  })

  it('does not track reads inside iterator continuations', async () => {
    const source = signal(1)
    const produce = vi.fn(() =>
      (async function* () {
        yield source()
      })(),
    )
    const memo = own(createAsyncMemo(produce))
    memo.state()
    await drain()
    expect(memo()).toBe(1)
    source(2)
    expect(memo()).toBe(1)
    expect(produce).toHaveBeenCalledTimes(1)
  })
})
