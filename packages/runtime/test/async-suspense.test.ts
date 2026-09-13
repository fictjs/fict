import { afterEach, describe, expect, it } from 'vitest'
import { createAsyncMemo, type AsyncMemo } from '../src/async-memo'
import { reactive, insertBetween, createConditional, spread } from '../src/binding'
import { createElement } from '../src/dom'
import {
  ErrorBoundary as RuntimeErrorBoundary,
  Fragment,
  onCleanup,
  onMount,
  render,
  Suspense as RuntimeSuspense,
} from '../src/index'
import { __resetReactiveState, flush, signal } from '../src/signal'

type VNodeComponent = (props: Record<string, unknown>) => import('../src/types').FictNode
const Suspense: VNodeComponent = props =>
  RuntimeSuspense(props as unknown as Parameters<typeof RuntimeSuspense>[0])
const ErrorBoundary: VNodeComponent = props =>
  RuntimeErrorBoundary(props as unknown as Parameters<typeof RuntimeErrorBoundary>[0])

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
  for (let i = 0; i < 20; i++) await Promise.resolve()
  flush()
}

describe('async graph render boundaries', () => {
  it('keeps component-local computations and DOM alive while their binding is pending', async () => {
    const request = deferred<string>()
    const container = document.createElement('div')
    let renders = 0
    let mounts = 0
    let cleanups = 0
    let data!: AsyncMemo<string>
    const Child = () => {
      renders++
      data = createAsyncMemo(() => request.promise)
      onMount(() => {
        mounts++
      })
      onCleanup(() => {
        cleanups++
      })
      return { type: 'span', props: { children: reactive(() => data()) } }
    }
    const stop = render(
      () => ({
        type: Suspense,
        props: {
          fallback: 'loading',
          children: { type: Child, props: {} },
        },
      }),
      container,
    )
    disposers.push(stop)
    expect(container.textContent).toBe('loading')
    expect(data.state().status).toBe('pending')
    expect(cleanups).toBe(0)
    expect(mounts).toBe(0)
    request.resolve('ready')
    await drain()
    expect(container.textContent).toBe('ready')
    expect(renders).toBe(1)
    expect(mounts).toBe(1)
    stop()
    expect(cleanups).toBe(1)
    expect(data.state().status).toBe('disposed')
  })

  it('parks the same DOM during refresh and restores only a coherent pair', async () => {
    const id = signal(1)
    const request = deferred<string>()
    const container = document.createElement('div')
    let renders = 0
    let fallbackRuns = 0
    const Child = () => {
      renders++
      const data = createAsyncMemo(() => (id() === 1 ? 'first' : request.promise))
      return {
        type: 'span',
        props: { children: [reactive(() => data() + '-a'), reactive(() => data() + '-b')] },
      }
    }
    disposers.push(
      render(
        () => ({
          type: Suspense,
          props: {
            fallback: () => {
              fallbackRuns++
              return 'loading'
            },
            children: { type: Child, props: {} },
          },
        }),
        container,
      ),
    )
    const span = container.querySelector('span')
    expect(container.textContent).toBe('first-afirst-b')
    id(2)
    flush()
    expect(container.textContent).toBe('loading')
    expect(fallbackRuns).toBe(1)
    request.resolve('second')
    await drain()
    expect(container.textContent).toBe('second-asecond-b')
    expect(container.querySelector('span')).toBe(span)
    expect(renders).toBe(1)
  })

  it('keeps changing top-level binding ranges intact while parked', async () => {
    const id = signal(1)
    const request = deferred<string>()
    const container = document.createElement('div')
    const Child = () => {
      const data = createAsyncMemo(() => (id() === 1 ? 'first' : request.promise))
      return {
        type: Fragment,
        props: {
          children: reactive(() => ({
            type: 'b',
            props: { children: data() },
          })),
        },
      }
    }
    disposers.push(
      render(
        () => ({
          type: Suspense,
          props: {
            fallback: 'loading',
            children: { type: Child, props: {} },
          },
        }),
        container,
      ),
    )
    id(2)
    flush()
    expect(container.textContent).toBe('loading')
    request.resolve('second')
    await drain()
    expect(container.textContent).toBe('second')
    expect(container.querySelectorAll('b')).toHaveLength(1)
  })

  it('reveals independent boundaries separately and cancels a parked owner on unmount', async () => {
    const a = deferred<string>()
    const b = deferred<string>()
    const container = document.createElement('div')
    const aborts: string[] = []
    const child = (name: string, request: ReturnType<typeof deferred<string>>) => () => {
      const data = createAsyncMemo(({ signal }) => {
        signal.addEventListener('abort', () => {
          aborts.push(name)
        })
        return request.promise
      })
      return { type: 'span', props: { children: reactive(data) } }
    }
    const stop = render(
      () => ({
        type: Fragment,
        props: {
          children: [
            {
              type: Suspense,
              props: { fallback: 'A?', children: { type: child('a', a), props: {} } },
            },
            {
              type: Suspense,
              props: { fallback: 'B?', children: { type: child('b', b), props: {} } },
            },
          ],
        },
      }),
      container,
    )
    disposers.push(stop)
    expect(container.textContent).toBe('A?B?')
    a.resolve('A!')
    await drain()
    expect(container.textContent).toBe('A!B?')
    stop()
    expect(aborts.sort()).toEqual(['a', 'b'])
    b.resolve('late')
    await drain()
    expect(container.textContent).toBe('')
  })

  it('routes Promise rejection values to ErrorBoundary instead of waiting on them', async () => {
    const request = deferred<string>()
    const reason = Promise.resolve('error identity')
    const errors: unknown[] = []
    const container = document.createElement('div')
    const Child = () => {
      const data = createAsyncMemo(() => request.promise)
      return { type: 'span', props: { children: reactive(data) } }
    }
    disposers.push(
      render(
        () => ({
          type: ErrorBoundary,
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
  })

  it('explains pending reads in non-resumable synchronous component setup', () => {
    const request = deferred<string>()
    const container = document.createElement('div')
    const Child = () => {
      const data = createAsyncMemo(() => request.promise)
      return data()
    }
    expect(() =>
      render(
        () => ({
          type: Suspense,
          props: {
            fallback: 'loading',
            children: { type: Child, props: {} },
          },
        }),
        container,
      ),
    ).toThrow('synchronous component setup cannot resume')
  })

  it('releases abandoned branch waits without waiting for their transport', async () => {
    const a = signal(true)
    const b = signal(true)
    const request = deferred<string>()
    const container = document.createElement('div')
    const Child = () => {
      const data = createAsyncMemo(() => request.promise)
      return {
        type: 'span',
        props: {
          children: [reactive(() => (a() ? data() : 'A')), reactive(() => (b() ? data() : 'B'))],
        },
      }
    }
    disposers.push(
      render(
        () => ({
          type: Suspense,
          props: {
            fallback: 'loading',
            children: { type: Child, props: {} },
          },
        }),
        container,
      ),
    )
    a(false)
    await drain()
    expect(container.textContent).toBe('loading')
    b(false)
    await drain()
    expect(container.textContent).toBe('AB')
    request.resolve('late')
    await drain()
    expect(container.textContent).toBe('AB')
  })

  it('resets a parked view and ignores all previous consumer wakeups', async () => {
    const version = signal(0)
    const first = deferred<string>()
    const second = deferred<string>()
    const container = document.createElement('div')
    const cleanups: number[] = []
    const Child = () => {
      const current = version()
      const data = createAsyncMemo(() => (current === 0 ? first.promise : second.promise))
      onCleanup(() => {
        cleanups.push(current)
      })
      return { type: 'span', props: { children: reactive(data) } }
    }
    disposers.push(
      render(
        () => ({
          type: Suspense,
          props: {
            resetKeys: reactive(version),
            fallback: 'loading',
            children: { type: Child, props: {} },
          },
        }),
        container,
      ),
    )
    version(1)
    await drain()
    expect(cleanups).toEqual([0])
    expect(container.textContent).toBe('loading')
    first.resolve('stale')
    await drain()
    expect(container.textContent).toBe('loading')
    second.resolve('current')
    await drain()
    expect(container.textContent).toBe('current')
  })

  it('retains nested compiled child roots and defers all their mounts until reveal', async () => {
    const request = deferred<string>()
    const container = document.createElement('div')
    let mounts = 0
    let productions = 0
    const Child = () => {
      const data = createAsyncMemo(() => {
        productions++
        return request.promise
      })
      onMount(() => {
        mounts++
      })
      return { type: 'b', props: { children: reactive(data) } }
    }
    const Parent = () => {
      const fragment = document.createDocumentFragment()
      const start = document.createComment('start')
      const end = document.createComment('end')
      fragment.append(start, end)
      insertBetween(start, end, () => ({ type: Child, props: {} }), createElement)
      return fragment
    }
    disposers.push(
      render(
        () => ({
          type: Suspense,
          props: {
            fallback: 'loading',
            children: { type: Parent, props: {} },
          },
        }),
        container,
      ),
    )
    expect(container.textContent).toBe('loading')
    expect(mounts).toBe(0)
    request.resolve('ready')
    await drain()
    expect(container.textContent).toBe('ready')
    expect(productions).toBe(1)
    expect(mounts).toBe(1)
  })

  it('prepares all spread property reads before writing any of them', async () => {
    const version = signal(0)
    const request = deferred<string>()
    const container = document.createElement('div')
    let element!: HTMLElement
    const Child = () => {
      const data = createAsyncMemo(() => (version() === 0 ? 'first' : request.promise))
      element = document.createElement('div')
      spread(element, () => ({
        title: `version:${version()}`,
        get id() {
          return data()
        },
      }))
      return element
    }
    disposers.push(
      render(
        () => ({
          type: Suspense,
          props: {
            fallback: 'loading',
            children: { type: Child, props: {} },
          },
        }),
        container,
      ),
    )
    version(1)
    flush()
    expect(element.title).toBe('version:0')
    expect(element.id).toBe('first')
    request.resolve('second')
    await drain()
    expect(element.title).toBe('version:1')
    expect(element.id).toBe('second')
  })

  it('lets a tracked conditional leave a pending branch', async () => {
    const choose = signal(true)
    const request = deferred<string>()
    const container = document.createElement('div')
    const Child = () => {
      const data = createAsyncMemo(() => request.promise)
      return createConditional(
        choose,
        () => data(),
        createElement,
        () => 'other',
        undefined,
        undefined,
        { trackBranchReads: true },
      ).marker
    }
    disposers.push(
      render(
        () => ({
          type: Suspense,
          props: {
            fallback: 'loading',
            children: { type: Child, props: {} },
          },
        }),
        container,
      ),
    )
    choose(false)
    await drain()
    expect(container.textContent).toBe('other')
    request.resolve('late')
    await drain()
    expect(container.textContent).toBe('other')
  })

  it('keeps the retained owner when fallback cleanup starts another async generation', async () => {
    const version = signal(0)
    const first = deferred<string>()
    const second = deferred<string>()
    const container = document.createElement('div')
    let renders = 0
    const Child = () => {
      renders++
      const data = createAsyncMemo(() => (version() === 0 ? first.promise : second.promise))
      return { type: 'span', props: { children: reactive(data) } }
    }
    let supersede = true
    const Fallback = () => {
      onCleanup(() => {
        if (supersede) {
          supersede = false
          version(1)
          flush()
        }
      })
      return 'loading'
    }
    disposers.push(
      render(
        () => ({
          type: Suspense,
          props: {
            fallback: { type: Fallback, props: {} },
            children: { type: Child, props: {} },
          },
        }),
        container,
      ),
    )
    first.resolve('stale')
    await drain()
    expect(container.textContent).toBe('loading')
    second.resolve('current')
    await drain()
    expect(container.textContent).toBe('current')
    expect(renders).toBe(1)
  })
})
