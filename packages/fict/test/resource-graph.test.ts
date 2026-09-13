import { afterEach, describe, expect, it } from 'vitest'
import { createAsyncMemo, createSignal, reactive } from '@fictjs/runtime/advanced'
import {
  createEffect,
  createMemo,
  createRoot,
  render,
  Suspense,
  ErrorBoundary,
  onCleanup,
  batch,
} from '@fictjs/runtime'
import { __resetReactiveState } from '@fictjs/runtime/internal'
import { resource, type ResourceResult } from '../src/resource'

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
  for (let i = 0; i < 16; i++) await Promise.resolve()
}

describe('Resource async graph integration', () => {
  it('composes through synchronous and asynchronous derived nodes without replaying setup', async () => {
    const request = deferred<number>()
    const query = resource<number, string>({ fetch: () => request.promise, suspense: true })
    const container = document.createElement('div')
    let setups = 0
    const Child = () => {
      setups++
      const result = query.read('key')
      const twice = createMemo(() => result.data! * 2)
      const last = createAsyncMemo(() => Promise.resolve(twice() + 1))
      return { type: 'b', props: { children: reactive(last) } }
    }
    disposers.push(
      render(
        () => ({
          type: Suspense as never,
          props: { fallback: 'loading', children: { type: Child, props: {} } },
        }),
        container,
      ),
    )
    expect(container.textContent).toBe('loading')
    request.resolve(3)
    await drain()
    expect(container.textContent).toBe('7')
    expect(setups).toBe(1)
  })

  it('preserves field-level equality while publishing one coherent async state', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    let calls = 0
    const query = resource<string, string>(() => (calls++ ? second.promise : first.promise))
    const values: (string | undefined)[] = []
    const loading: boolean[] = []
    const states: [string | undefined, boolean, unknown][] = []
    let result!: ResourceResult<string>
    const owner = createRoot(() => {
      result = query.read('key')
      createEffect(() => {
        values.push(result.data)
      })
      createEffect(() => {
        loading.push(result.loading)
      })
      createEffect(() => {
        states.push([result.data, result.loading, result.error])
      })
    })
    disposers.push(owner.dispose)
    first.resolve('same')
    await drain()
    result.refresh()
    await drain()
    second.resolve('same')
    await drain()
    expect(values).toEqual([undefined, 'same'])
    expect(loading).toEqual([true, false, true, false])
    expect(states).toEqual([
      [undefined, true, undefined],
      ['same', false, undefined],
      ['same', true, undefined],
      ['same', false, undefined],
    ])
  })

  it('keeps shared cache work alive when one reactive reader unmounts', async () => {
    const request = deferred<string>()
    let calls = 0
    let aborted = false
    const query = resource<string, string>({
      fetch: ({ signal }) => {
        calls++
        signal.addEventListener('abort', () => {
          aborted = true
        })
        return request.promise
      },
      suspense: true,
    })
    const containers = [document.createElement('div'), document.createElement('div')]
    const stops = containers.map(container =>
      render(
        () => ({
          type: Suspense as never,
          props: {
            fallback: 'loading',
            children: {
              type: () => {
                const result = query.read('shared')
                return { type: 'span', props: { children: reactive(() => result.data) } }
              },
              props: {},
            },
          },
        }),
        container,
      ),
    )
    disposers.push(...stops)
    stops[0]!()
    expect(aborted).toBe(false)
    request.resolve('ready')
    await drain()
    expect(containers.map(x => x.textContent)).toEqual(['', 'ready'])
    expect(calls).toBe(1)
  })

  it.each([undefined, Promise.resolve('rejection identity')])(
    'preserves arbitrary errors through graph render consumers: %s',
    async reason => {
      const request = deferred<string>()
      const query = resource<string, string>({ fetch: () => request.promise, suspense: true })
      const errors: unknown[] = []
      const container = document.createElement('div')
      const Child = () => {
        const result = query.read('key')
        const label = createMemo(() => result.data)
        return { type: 'span', props: { children: reactive(label) } }
      }
      disposers.push(
        render(
          () => ({
            type: ErrorBoundary as never,
            props: {
              fallback: (error: unknown) => {
                errors.push(error)
                return 'failed'
              },
              children: {
                type: Suspense,
                props: { fallback: 'loading', children: { type: Child, props: {} } },
              },
            },
          }),
          container,
        ),
      )
      request.reject(reason)
      await drain()
      expect(container.textContent).toBe('failed')
      expect(errors).toEqual([reason])
    },
  )

  it('invalidates a pending graph generation and ignores its stale completion', async () => {
    const requests = [deferred<string>(), deferred<string>()]
    let calls = 0
    const query = resource<string, string>({
      fetch: () => requests[calls++]!.promise,
      suspense: true,
    })
    const container = document.createElement('div')
    const Child = () => {
      const result = query.read('key')
      return { type: 'span', props: { children: reactive(() => result.data) } }
    }
    disposers.push(
      render(
        () => ({
          type: Suspense as never,
          props: { fallback: 'loading', children: { type: Child, props: {} } },
        }),
        container,
      ),
    )
    query.invalidate('key')
    await drain()
    requests[0]!.resolve('stale')
    await drain()
    expect(container.textContent).toBe('loading')
    requests[1]!.resolve('current')
    await drain()
    expect(container.textContent).toBe('current')
    expect(calls).toBe(2)
  })

  it('supports a first data read from cleanup without an uninitialized projection value', async () => {
    const query = resource<string, string>(() => Promise.resolve('ready'))
    const trigger = createSignal(0)
    const values: (string | undefined)[] = []
    const owner = createRoot(() => {
      const result = query.read('key')
      createEffect(() => {
        trigger()
        onCleanup(() => {
          values.push(result.data)
        })
      })
    })
    disposers.push(owner.dispose)
    await drain()
    batch(() => trigger(1))
    expect(values).toEqual(['ready'])
  })

  it('preserves a live reader snapshot after LRU eviction and refreshes through a new entry', async () => {
    const failure = new Error('cached failure')
    let calls = 0
    const query = resource<string, string>({
      fetch: (_, key) => {
        calls++
        return calls === 1 ? Promise.reject(failure) : Promise.resolve(key)
      },
      cache: { maxEntries: 1, cacheErrors: true },
    })
    const owner = createRoot(() => query.read('first'))
    disposers.push(owner.dispose)
    await drain()
    expect(owner.value.error).toBe(failure)
    query.prefetch('second')
    await drain()
    expect(owner.value.error).toBe(failure)
    expect(owner.value.loading).toBe(false)
    owner.value.refresh()
    await drain()
    expect(owner.value.data).toBe('first')
    expect(owner.value.error).toBeUndefined()
    expect(calls).toBe(3)
  })

  it('replaces an in-flight generation when the explicit reset token changes', async () => {
    const requests = [deferred<string>(), deferred<string>()]
    const signals: AbortSignal[] = []
    const reset = createSignal(0)
    const query = resource<string, string>({
      fetch: ({ signal }) => {
        signals.push(signal)
        return requests[signals.length - 1]!.promise
      },
      reset: reactive(reset),
    })
    const owner = createRoot(() => query.read('key'))
    disposers.push(owner.dispose)
    batch(() => reset(1))
    expect(signals).toHaveLength(2)
    expect(signals[0]!.aborted).toBe(true)
    requests[0]!.resolve('superseded')
    await drain()
    expect(owner.value.data).toBeUndefined()
    expect(owner.value.loading).toBe(true)
    requests[1]!.resolve('current')
    await drain()
    expect(owner.value.data).toBe('current')
  })
})
