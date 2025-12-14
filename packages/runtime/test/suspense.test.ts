import { describe, it, expect } from 'vitest'

import {
  Suspense,
  createSuspenseToken,
  createSignal,
  render,
  ErrorBoundary,
  Fragment,
} from '../src/index'

const tick = () => Promise.resolve()

describe('Suspense', () => {
  it('renders fallback while pending and resumes on resolve', async () => {
    const { token, resolve } = createSuspenseToken()
    const container = document.createElement('div')

    let first = true
    const Child = () => {
      if (first) {
        first = false
        throw token
      }
      return { type: 'span', props: { children: 'ready' } }
    }

    const dispose = render(
      () => ({
        type: Suspense,
        props: {
          fallback: 'loading',
          children: { type: Child, props: {} },
        },
      }),
      container,
    )

    await tick()
    await tick()
    await tick()
    expect(container.textContent).toBe('loading')

    resolve()
    await tick()
    await tick()

    expect(container.textContent).toBe('ready')

    dispose()
  })

  it('calls onReject when token rejects', async () => {
    const { token, reject } = createSuspenseToken()
    const container = document.createElement('div')
    let rejected: unknown = null

    const Thrower = () => {
      throw token
    }

    const dispose = render(
      () => ({
        type: ErrorBoundary,
        props: {
          fallback: 'error',
          children: {
            type: Suspense,
            props: {
              fallback: 'loading',
              onReject: err => {
                rejected = err
              },
              children: { type: Thrower, props: {} },
            },
          },
        },
      }),
      container,
    )

    await tick()
    await tick()
    expect(container.textContent).toBe('loading')

    reject(new Error('boom'))
    await tick()

    expect(rejected).toBeInstanceOf(Error)
    expect(container.textContent).toBe('error')

    dispose()
  })

  it('resetKeys resets pending and reruns children', async () => {
    const container = document.createElement('div')
    const shouldSuspend = createSignal(true)
    const reset = createSignal(0)

    const Child = () => {
      if (shouldSuspend()) {
        const { token } = createSuspenseToken()
        throw token
      }
      return { type: 'span', props: { children: 'ok' } }
    }

    const dispose = render(
      () => ({
        type: Suspense,
        props: {
          fallback: 'loading',
          resetKeys: () => reset(),
          children: { type: Child, props: {} },
        },
      }),
      container,
    )

    await tick()
    expect(container.textContent).toBe('loading')

    shouldSuspend(false)
    reset(1)
    await tick()

    expect(container.textContent).toBe('ok')

    dispose()
  })

  it('waits for multiple tokens before resuming', async () => {
    const t1 = createSuspenseToken()
    const t2 = createSuspenseToken()
    const container = document.createElement('div')

    let firstA = true
    let firstB = true
    const A = () => {
      if (firstA) {
        firstA = false
        throw t1.token
      }
      return { type: 'span', props: { children: 'A' } }
    }
    const B = () => {
      if (firstB) {
        firstB = false
        throw t2.token
      }
      return { type: 'span', props: { children: 'B' } }
    }

    const dispose = render(
      () => ({
        type: Suspense,
        props: {
          fallback: 'loading',
          children: {
            type: Fragment,
            props: {
              children: [
                { type: A, props: {} },
                { type: B, props: {} },
              ],
            },
          },
        },
      }),
      container,
    )

    await tick()
    expect(container.textContent).toBe('loading')

    t1.resolve()
    await tick()
    await tick()
    // Still waiting for the second token
    expect(container.textContent).toBe('loading')

    t2.resolve()
    await tick()
    await tick()
    expect(container.textContent).toBe('AB')

    dispose()
  })

  it('does not remove sibling nodes when showing fallback', async () => {
    const { token, resolve } = createSuspenseToken()
    const container = document.createElement('div')

    let first = true
    const Child = () => {
      if (first) {
        first = false
        throw token
      }
      return { type: 'span', props: { children: 'C' } }
    }

    render(
      () => ({
        type: 'div',
        props: {
          children: [
            { type: 'span', props: { children: 'L' } },
            {
              type: Suspense,
              props: { fallback: 'loading', children: { type: Child, props: {} } },
            },
            { type: 'span', props: { children: 'R' } },
          ],
        },
      }),
      container,
    )

    await tick()
    expect(container.textContent).toBe('LloadingR')

    resolve()
    await tick()
    await tick()

    expect(container.textContent).toBe('LCR')
  })
})
