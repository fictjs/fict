import { afterEach, describe, expect, it } from 'vitest'
import { createAsyncMemo } from '../src/async-memo'
import { createEffect } from '../src/effect'
import { createRoot } from '../src/lifecycle'
import { createMemo } from '../src/memo'
import { __resetReactiveState, createSignal, flush } from '../src/signal'
import { useTransition } from '../src/transition'

const disposers: (() => void)[] = []
afterEach(() => {
  while (disposers.length) disposers.pop()!()
  __resetReactiveState()
})
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => {
    resolve = yes
  })
  return { promise, resolve }
}
const drain = async () => {
  for (let i = 0; i < 24; i++) await Promise.resolve()
}

describe('causal async transitions', () => {
  it('waits for a computation started by a queued input update without a returned Promise', async () => {
    const request = deferred<number>()
    const owner = createRoot(() => {
      const input = createSignal(0)
      const memo = createAsyncMemo(() => (input() ? request.promise : 0))
      memo.state()
      const [pending, start] = useTransition()
      return { input, memo, pending, start }
    })
    disposers.push(owner.dispose)
    const { input, memo, pending, start } = owner.value
    start(() => input(1))
    await drain()
    expect(pending()).toBe(true)
    request.resolve(7)
    await drain()
    expect(memo()).toBe(7)
    expect(pending()).toBe(false)
  })

  it('carries causality through effect writes and async-to-sync-to-async chains', async () => {
    const first = deferred<number>()
    const last = deferred<number>()
    const owner = createRoot(() => {
      const input = createSignal(0)
      const bridge = createSignal(0)
      createEffect(() => {
        bridge(input())
      })
      const a = createAsyncMemo(() => (bridge() ? first.promise : 0))
      const b = createMemo(() => a() * 2)
      const c = createAsyncMemo(() => (b() ? last.promise : 0))
      c.state()
      const [pending, start] = useTransition()
      return { input, c, pending, start }
    })
    disposers.push(owner.dispose)
    owner.value.start(() => owner.value.input(1))
    await drain()
    expect(owner.value.pending()).toBe(true)
    first.resolve(3)
    await drain()
    expect(owner.value.pending()).toBe(true)
    last.resolve(9)
    await drain()
    expect(owner.value.c()).toBe(9)
    expect(owner.value.pending()).toBe(false)
  })

  it('isolates unrelated roots and overlapping transitions', async () => {
    const requests = [deferred<number>(), deferred<number>()]
    const owners = requests.map(request =>
      createRoot(() => {
        const input = createSignal(0)
        const memo = createAsyncMemo(() => (input() ? request.promise : 0))
        memo.state()
        const [pending, start] = useTransition()
        return { input, pending, start }
      }),
    )
    disposers.push(...owners.map(x => x.dispose))
    owners[0]!.value.start(() => owners[0]!.value.input(1))
    owners[1]!.value.start(() => owners[1]!.value.input(1))
    await drain()
    expect(owners.map(x => x.value.pending())).toEqual([true, true])
    requests[1]!.resolve(2)
    await drain()
    expect(owners.map(x => x.value.pending())).toEqual([true, false])
    requests[0]!.resolve(1)
    await drain()
    expect(owners.map(x => x.value.pending())).toEqual([false, false])
  })

  it('does not transfer a superseded queued write to the transition that replaced it', async () => {
    const request = deferred<number>()
    const owner = createRoot(() => {
      const input = createSignal(0)
      const memo = createAsyncMemo(() => (input() ? request.promise : 0))
      memo.state()
      return { input, first: useTransition(), second: useTransition() }
    })
    disposers.push(owner.dispose)
    const { input, first, second } = owner.value
    first[1](() => input(1))
    second[1](() => input(2))
    await drain()
    expect([first[0](), second[0]()]).toEqual([false, true])
    request.resolve(2)
    await drain()
    expect(second[0]()).toBe(false)
  })

  it('keeps both causes when different inputs update one already-queued computation', async () => {
    const request = deferred<number>()
    const owner = createRoot(() => {
      const a = createSignal(0)
      const b = createSignal(0)
      const memo = createAsyncMemo(() => (a() + b() ? request.promise : 0))
      memo.state()
      return { a, b, first: useTransition(), second: useTransition() }
    })
    disposers.push(owner.dispose)
    const { a, b, first, second } = owner.value
    first[1](() => a(1))
    second[1](() => b(2))
    await drain()
    expect([first[0](), second[0]()]).toEqual([true, true])
    request.resolve(3)
    await drain()
    expect([first[0](), second[0]()]).toEqual([false, false])
  })

  it('releases replaced generations and ignores a late stale completion', async () => {
    const requests = [deferred<number>(), deferred<number>()]
    const owner = createRoot(() => {
      const input = createSignal(0)
      const memo = createAsyncMemo(() => {
        const value = input()
        return value ? requests[value - 1]!.promise : 0
      })
      memo.state()
      return { input, memo, first: useTransition(), second: useTransition() }
    })
    disposers.push(owner.dispose)
    const { input, memo, first, second } = owner.value
    first[1](() => input(1))
    await drain()
    second[1](() => input(2))
    await drain()
    expect([first[0](), second[0]()]).toEqual([false, true])
    requests[0]!.resolve(1)
    await drain()
    expect(second[0]()).toBe(true)
    requests[1]!.resolve(2)
    await drain()
    expect(memo()).toBe(2)
    expect(second[0]()).toBe(false)
  })

  it('does not wait for unrelated background async work', async () => {
    const foreground = deferred<number>()
    const background = deferred<number>()
    const owner = createRoot(() => {
      const input = createSignal(0)
      createAsyncMemo(() => background.promise).state()
      createAsyncMemo(() => (input() ? foreground.promise : 0)).state()
      const [pending, start] = useTransition()
      return { input, pending, start }
    })
    disposers.push(owner.dispose)
    owner.value.start(() => owner.value.input(1))
    await drain()
    foreground.resolve(1)
    await drain()
    expect(owner.value.pending()).toBe(false)
  })

  it('ends pending on owner disposal even when transport never settles', async () => {
    const request = deferred<number>()
    const owner = createRoot(() => {
      const [pending, start] = useTransition()
      start(() => {
        createAsyncMemo(() => request.promise).state()
      })
      return pending
    })
    await drain()
    expect(owner.value()).toBe(true)
    owner.dispose()
    flush()
    expect(owner.value()).toBe(false)
  })

  it('does not attribute an urgent replacement to the superseded transition', async () => {
    const requests = [deferred<number>(), deferred<number>()]
    const owner = createRoot(() => {
      const input = createSignal(0)
      const memo = createAsyncMemo(() => {
        const value = input()
        return value ? requests[value - 1]!.promise : 0
      })
      memo.state()
      const [pending, start] = useTransition()
      return { input, memo, pending, start }
    })
    disposers.push(owner.dispose)
    owner.value.start(() => owner.value.input(1))
    await drain()
    expect(owner.value.pending()).toBe(true)
    owner.value.input(2)
    await drain()
    expect(owner.value.pending()).toBe(false)
    expect(owner.value.memo.state().status).toBe('refreshing')
  })

  it('releases queued accounting when equality avoids a producer rerun', async () => {
    let calls = 0
    const owner = createRoot(() => {
      const input = createSignal(0)
      const parity = createMemo(() => input() % 2)
      const memo = createAsyncMemo(() => {
        calls++
        return parity()
      })
      memo.state()
      const [pending, start] = useTransition()
      return { input, pending, start }
    })
    disposers.push(owner.dispose)
    owner.value.start(() => owner.value.input(2))
    await drain()
    expect(owner.value.pending()).toBe(false)
    expect(calls).toBe(1)
  })

  it('joins an explicitly read pending async computation and waits only for first stream readiness', async () => {
    const first = deferred<IteratorResult<number>>()
    const next = deferred<IteratorResult<number>>()
    let calls = 0
    const owner = createRoot(() => {
      const stream = createAsyncMemo(() => ({
        [Symbol.asyncIterator]() {
          return { next: () => (calls++ ? next.promise : first.promise) }
        },
      }))
      stream.state()
      const [pending, start] = useTransition()
      start(() => {
        stream.state()
      })
      return { stream, pending }
    })
    disposers.push(owner.dispose)
    await drain()
    expect(owner.value.pending()).toBe(true)
    first.resolve({ done: false, value: 1 })
    await drain()
    expect(owner.value.stream()).toBe(1)
    expect(owner.value.pending()).toBe(false)
  })

  it.each([true, false])(
    'waits for both the returned Promise and indirect graph work: returned first=%s',
    async returnedFirst => {
      const returned = deferred<void>()
      const request = deferred<number>()
      const owner = createRoot(() => {
        const input = createSignal(0)
        const memo = createAsyncMemo(() => (input() ? request.promise : 0))
        memo.state()
        const [pending, start] = useTransition()
        start(() => {
          input(1)
          return returned.promise
        })
        return pending
      })
      disposers.push(owner.dispose)
      await drain()
      if (returnedFirst) returned.resolve()
      else request.resolve(1)
      await drain()
      expect(owner.value()).toBe(true)
      returned.resolve()
      request.resolve(1)
      await drain()
      expect(owner.value()).toBe(false)
    },
  )

  it('releases scheduled graph work when its consumer is disposed before the flush', async () => {
    const request = deferred<number>()
    let calls = 0
    const owner = createRoot(() => {
      const input = createSignal(0)
      const consumer = createRoot(() => {
        createAsyncMemo(() => {
          calls++
          return input() ? request.promise : 0
        }).state()
      })
      const [pending, start] = useTransition()
      start(() => input(1))
      consumer.dispose()
      return pending
    })
    disposers.push(owner.dispose)
    await drain()
    expect(owner.value()).toBe(false)
    expect(calls).toBe(1)
  })
})
