import { afterEach, expect, it } from 'vitest'
import { createRoot, render, Suspense } from '@fictjs/runtime'
import { createSignal, reactive } from '@fictjs/runtime/advanced'
import { __resetReactiveState } from '@fictjs/runtime/internal'
import { resource } from '../src/resource'

const disposers: (() => void)[] = []
afterEach(() => {
  while (disposers.length) disposers.pop()!()
  __resetReactiveState()
})
const drain = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}
const request = () => {
  let resolve!: (value: string) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<string>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject, signal: undefined as AbortSignal | undefined }
}

it.each(['graph', 'legacy', 'plain'])(
  'no-cache %s readers cancel only after the last owner leaves',
  async kind => {
    const requests: ReturnType<typeof request>[] = []
    const query = resource<string, string>({
      suspense: kind !== 'plain',
      cache: { mode: 'none' },
      fetch: ({ signal }) => {
        const next = request()
        next.signal = signal
        requests.push(next)
        return next.promise
      },
    })
    const mount = () => {
      const container = document.createElement('div')
      const dispose = render(
        () => ({
          type: Suspense as never,
          props: {
            fallback: 'loading',
            children: {
              type: () => {
                const result = query.read('shared')
                return {
                  type: 'span',
                  props: { children: kind === 'graph' ? reactive(() => result.data) : result.data },
                }
              },
              props: {},
            },
          },
        }),
        container,
      )
      disposers.push(dispose)
      return { container, dispose }
    }
    const a = mount(),
      b = mount()
    expect(requests).toHaveLength(1)
    a.dispose()
    expect(requests[0]!.signal!.aborted).toBe(false)
    b.dispose()
    expect(requests[0]!.signal!.aborted).toBe(true)
    const c = mount()
    expect(requests).toHaveLength(2)
    requests[0]!.resolve('obsolete')
    await drain()
    expect(c.container.textContent).toBe(kind === 'plain' ? '' : 'loading')
    requests[1]!.resolve('ready')
    await drain()
    if (kind !== 'plain') expect(c.container.textContent).toBe('ready')
    expect(requests).toHaveLength(2)
  },
)

it.each(['graph', 'legacy'])(
  'reset releases a no-cache %s wait before its abandoned transport settles',
  async kind => {
    const key = createSignal(0)
    const requests: ReturnType<typeof request>[] = []
    const query = resource<string, number>({
      suspense: true,
      cache: { mode: 'none' },
      fetch: ({ signal }) => {
        const next = request()
        next.signal = signal
        requests.push(next)
        return next.promise
      },
    })
    const container = document.createElement('div')
    disposers.push(
      render(
        () => ({
          type: Suspense as never,
          props: {
            fallback: 'loading',
            resetKeys: reactive(() => key()),
            children: {
              type: () => {
                const result = query.read(key())
                return {
                  type: 'span',
                  props: { children: kind === 'graph' ? reactive(() => result.data) : result.data },
                }
              },
              props: {},
            },
          },
        }),
        container,
      ),
    )
    expect(container.textContent).toBe('loading')
    key(1)
    await drain()
    expect(requests[0]!.signal!.aborted).toBe(true)
    expect(requests).toHaveLength(2)
    requests[0]!.reject('obsolete')
    await drain()
    expect(container.textContent).toBe('loading')
    requests[1]!.resolve('ready')
    await drain()
    expect(container.textContent).toBe('ready')
  },
)

it('a prefetch owner cannot cancel a request retained by a resource reader', async () => {
  const next = request()
  const query = resource<string, string>({
    cache: { mode: 'none' },
    fetch: ({ signal }) => {
      next.signal = signal
      return next.promise
    },
  })
  const prefetch = createRoot(() => query.prefetch('key'))
  const reader = createRoot(() => query.read('key'))
  disposers.push(prefetch.dispose, reader.dispose)
  prefetch.dispose()
  expect(next.signal!.aborted).toBe(false)
  reader.dispose()
  expect(next.signal!.aborted).toBe(true)
  next.reject('obsolete')
  await drain()
})

it('changing graph arguments cancels an unobserved initial request', async () => {
  const key = createSignal('a')
  const requests: ReturnType<typeof request>[] = []
  const query = resource<string, string>({
    suspense: true,
    cache: { mode: 'none' },
    fetch: ({ signal }) => {
      const next = request()
      next.signal = signal
      requests.push(next)
      return next.promise
    },
  })
  const container = document.createElement('div')
  disposers.push(
    render(
      () => ({
        type: Suspense as never,
        props: {
          fallback: 'loading',
          children: {
            type: () => {
              const result = query.read(reactive(() => key()))
              return { type: 'span', props: { children: reactive(() => result.data) } }
            },
            props: {},
          },
        },
      }),
      container,
    ),
  )
  key('b')
  await drain()
  expect(requests).toHaveLength(2)
  expect(requests[0]!.signal!.aborted).toBe(true)
  requests[1]!.resolve('B')
  await drain()
  expect(container.textContent).toBe('B')
  requests[0]!.resolve('obsolete')
  await drain()
  expect(container.textContent).toBe('B')
})

it('unowned no-cache prefetch releases its lease when the request settles', async () => {
  const requests: ReturnType<typeof request>[] = []
  const query = resource<string, string>({
    cache: { mode: 'none' },
    fetch: ({ signal }) => {
      const next = request()
      next.signal = signal
      requests.push(next)
      return next.promise
    },
  })
  query.prefetch('key')
  requests[0]!.resolve('done')
  await drain()
  const owner = createRoot(() => query.read('key'))
  disposers.push(owner.dispose)
  expect(requests).toHaveLength(2)
  owner.dispose()
  expect(requests[1]!.signal!.aborted).toBe(true)
})

it('an abort callback can start an independent reader for the same key', async () => {
  const requests: ReturnType<typeof request>[] = []
  let readSuccessor: (() => string | undefined) | undefined
  const query = resource<string, string>({
    cache: { mode: 'none' },
    fetch: ({ signal }) => {
      const next = request()
      next.signal = signal
      requests.push(next)
      if (requests.length === 1) {
        signal.addEventListener('abort', () => {
          const successor = createRoot(() => query.read('key'))
          readSuccessor = () => successor.value.data
          disposers.push(successor.dispose)
        })
      }
      return next.promise
    },
  })
  const first = createRoot(() => query.read('key'))
  disposers.push(first.dispose)
  first.dispose()
  expect(requests).toHaveLength(2)
  expect(requests[1]!.signal!.aborted).toBe(false)
  requests[1]!.resolve('ready')
  requests[0]!.reject('obsolete')
  await drain()
  expect(readSuccessor?.()).toBe('ready')
})

it('legacy replay retains resolved no-cache entries across sequential pending reads', async () => {
  const requests = new Map<string, ReturnType<typeof request>[]>()
  const query = resource<string, string>({
    suspense: true,
    cache: { mode: 'none' },
    fetch: ({ signal }, key) => {
      const next = request()
      next.signal = signal
      const history = requests.get(key) ?? []
      history.push(next)
      requests.set(key, history)
      return next.promise
    },
  })
  const container = document.createElement('div')
  disposers.push(
    render(
      () => ({
        type: Suspense as never,
        props: {
          fallback: 'loading',
          children: {
            type: () => {
              const a = query.read('a').data
              const b = query.read('b').data
              return { type: 'span', props: { children: `${a}:${b}` } }
            },
            props: {},
          },
        },
      }),
      container,
    ),
  )
  requests.get('a')![0]!.resolve('A')
  await drain()
  expect(container.textContent).toBe('loading')
  expect(requests.get('b')).toHaveLength(1)
  requests.get('b')![0]!.resolve('B')
  await drain()
  expect(container.textContent).toBe('A:B')
  expect(requests.get('a')).toHaveLength(1)
  expect(requests.get('b')).toHaveLength(1)
})
