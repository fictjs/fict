import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createEffect,
  createElement,
  createRoot,
  ErrorBoundary,
  render,
  Suspense,
} from '../src/index'
import { registerErrorHandler, registerSuspenseHandler } from '../src/lifecycle'
import { createAsyncMemo, createSignal, reactive } from '../src/advanced'
import { __fictProp, createPropsProxy } from '../src/internal'

const tick = () => new Promise<void>(resolve => queueMicrotask(resolve))
const drain = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

describe('Initialized component call props', () => {
  let container: HTMLElement
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })
  afterEach(() => {
    container.remove()
  })
  it('initializes call props once, tracks updates and retains object identity', async () => {
    const count = createSignal(0)
    const calls: number[] = []
    const scope = createRoot(() => {
      const getter = __fictProp(() => {
        const value = count()
        calls.push(value)
        return { value }
      }, true)
      const props = createPropsProxy({ value: getter })
      expect(calls).toEqual([0])
      expect(props.value).toBe(props.value)
      return { getter, props }
    })
    try {
      count(1)
      await tick()
      expect(scope.value.props.value).toEqual({ value: 1 })
      expect(scope.value.props.value).toBe(scope.value.props.value)
      expect(calls).toEqual([0, 1])
    } finally {
      scope.dispose()
    }
    count(2)
    await tick()
    expect(scope.value.getter()).toEqual({ value: 1 })
    expect(calls).toEqual([0, 1])
  })

  it('retains an initially unavailable call prop for its rendering consumer', async () => {
    let resolve!: (value: string) => void
    const request = new Promise<string>(yes => {
      resolve = yes
    })
    const Child = (props: Record<string, unknown>) => ({
      type: 'span',
      props: { children: reactive(() => String(props.value)) },
    })
    const Parent = () => {
      const data = createAsyncMemo(() => request)
      return { type: Child, props: { value: __fictProp(() => data(), true) } }
    }
    const dispose = render(
      () =>
        createElement({
          type: Suspense as unknown as typeof Child,
          props: { fallback: 'loading', children: { type: Parent, props: {} } },
        }),
      container,
    )
    try {
      expect(container.textContent).toBe('loading')
      resolve('ready')
      for (let i = 0; i < 20; i++) await tick()
      expect(container.textContent).toBe('ready')
    } finally {
      dispose()
    }
  })

  it('rethrows every initial graph rejection even when the prop is unread', async () => {
    const tokenSource = createAsyncMemo(() => new Promise<never>(() => {}))
    const token = tokenSource.state().pending
    try {
      for (const reason of [undefined, 'failure', Promise.resolve('error value'), token]) {
        const data = createAsyncMemo(() => Promise.reject(reason))
        data.state()
        await drain()
        try {
          let outcome: unknown
          try {
            const owner = createRoot(() => __fictProp(data, true))
            outcome = 'returned'
            owner.dispose()
          } catch (error) {
            outcome = { error }
          }
          expect(outcome).toEqual({ error: reason })
        } finally {
          data.dispose()
        }
      }
    } finally {
      tokenSource.dispose()
    }
  })

  it('forwards token-shaped rejection identity to ErrorBoundary during setup', async () => {
    const tokenSource = createAsyncMemo(() => new Promise<never>(() => {}))
    const reason = tokenSource.state().pending
    const data = createAsyncMemo(() => Promise.reject(reason))
    data.state()
    await drain()
    const errors: unknown[] = []
    let reached = false
    const dispose = render(
      () => ({
        type: ErrorBoundary as never,
        props: {
          fallback: 'failed',
          onError: (error: unknown) => errors.push(error),
          children: {
            type: () => {
              __fictProp(data, true)
              reached = true
              return 'ignored'
            },
            props: {},
          },
        },
      }),
      container,
    )
    try {
      expect(reached).toBe(false)
      expect(errors).toEqual([reason])
      expect(container.textContent).toBe('failed')
    } finally {
      dispose()
      data.dispose()
      tokenSource.dispose()
    }
  })

  it('restores effect error classification after the untracked initialization', async () => {
    const tokenSource = createAsyncMemo(() => new Promise<never>(() => {}))
    const reason = tokenSource.state().pending
    const data = createAsyncMemo(() => Promise.reject(reason))
    data.state()
    await drain()
    const errors: unknown[] = [],
      waits: unknown[] = []
    const owner = createRoot(() => {
      registerErrorHandler(error => {
        errors.push(error)
        return true
      })
      registerSuspenseHandler(token => {
        waits.push(token)
        return true
      })
      createEffect(() => {
        __fictProp(data, true)
      })
    })
    try {
      expect(errors).toEqual([reason])
      expect(waits).toEqual([])
    } finally {
      owner.dispose()
      data.dispose()
      tokenSource.dispose()
    }
  })
})
