import { describe, it, expect, vi } from 'vitest'

import {
  Suspense,
  createSuspenseToken,
  render,
  ErrorBoundary,
  Fragment,
  onMount,
} from '../src/index'
import { createSignal, reactive } from '../src/advanced'

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

  it('routes resolved child onMount errors to ErrorBoundary', async () => {
    const { token, resolve } = createSuspenseToken()
    const container = document.createElement('div')
    const error = new Error('resolved mount boom')
    let first = true
    let captured: unknown = null

    const Child = () => {
      if (first) {
        first = false
        throw token
      }
      onMount(() => {
        throw error
      })
      return { type: 'span', props: { children: 'ready' } }
    }

    const dispose = render(
      () => ({
        type: ErrorBoundary,
        props: {
          fallback: 'error',
          onError: err => {
            captured = err
          },
          children: {
            type: Suspense,
            props: { fallback: 'loading', children: { type: Child, props: {} } },
          },
        },
      }),
      container,
    )

    await tick()
    await tick()
    expect(container.textContent).toBe('loading')

    resolve()
    await tick()
    await tick()

    expect(captured).toBe(error)
    expect(container.textContent).toBe('error')

    dispose()
  })

  it('routes Suspense fallback onMount errors to ErrorBoundary', async () => {
    const { token } = createSuspenseToken()
    const container = document.createElement('div')
    const error = new Error('fallback mount boom')
    let captured: unknown = null

    const BadFallback = () => {
      onMount(() => {
        throw error
      })
      return { type: 'span', props: { children: 'loading' } }
    }

    const Child = () => {
      throw token
    }

    const dispose = render(
      () => ({
        type: ErrorBoundary,
        props: {
          fallback: 'error',
          onError: err => {
            captured = err
          },
          children: {
            type: Suspense,
            props: {
              fallback: { type: BadFallback, props: {} },
              children: { type: Child, props: {} },
            },
          },
        },
      }),
      container,
    )

    await tick()
    expect(captured).toBe(error)
    expect(container.textContent).toBe('error')

    dispose()
  })

  it('keeps resolved child onMount errors inside nested ErrorBoundary', async () => {
    const { token, resolve } = createSuspenseToken()
    const container = document.createElement('div')
    let first = true
    let outerError: unknown = null

    const BadMount = () => {
      onMount(() => {
        throw new Error('inner mount boom')
      })
      return { type: 'span', props: { children: 'ready' } }
    }

    const Child = () => {
      if (first) {
        first = false
        throw token
      }
      return {
        type: ErrorBoundary,
        props: {
          fallback: 'inner',
          children: { type: BadMount, props: {} },
        },
      }
    }

    const dispose = render(
      () => ({
        type: ErrorBoundary,
        props: {
          fallback: 'outer',
          onError: err => {
            outerError = err
          },
          children: {
            type: Suspense,
            props: {
              fallback: 'loading',
              children: { type: Child, props: {} },
            },
          },
        },
      }),
      container,
    )

    await tick()
    await tick()
    expect(container.textContent).toBe('loading')

    resolve()
    await tick()
    await tick()

    expect(outerError).toBe(null)
    expect(container.textContent).toBe('inner')

    dispose()
  })

  it('runs onMount once after Suspense resolves successfully', async () => {
    const { token, resolve } = createSuspenseToken()
    const container = document.createElement('div')
    let first = true
    let mounted = 0

    const Child = () => {
      if (first) {
        first = false
        throw token
      }
      onMount(() => {
        mounted += 1
      })
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
    expect(container.textContent).toBe('loading')

    resolve()
    await tick()
    await tick()

    expect(container.textContent).toBe('ready')
    expect(mounted).toBe(1)

    dispose()
  })

  it('does not run onMount when render fails inside Suspense', async () => {
    const container = document.createElement('div')
    let mounted = 0

    const Bad = () => {
      onMount(() => {
        mounted += 1
      })
      throw new Error('boom')
    }

    render(
      () => ({
        type: ErrorBoundary,
        props: {
          fallback: 'error',
          children: {
            type: Suspense,
            props: { fallback: 'loading', children: { type: Bad, props: {} } },
          },
        },
      }),
      container,
    )

    await tick()
    expect(container.textContent).toBe('error')
    expect(mounted).toBe(0)
  })

  it('does not run onMount when fallback render fails', async () => {
    const container = document.createElement('div')
    let mounted = 0

    const { token } = createSuspenseToken()

    const BadFallback = () => {
      onMount(() => {
        mounted += 1
      })
      throw new Error('fallback boom')
    }

    const Child = () => {
      throw token
    }

    render(
      () => ({
        type: ErrorBoundary,
        props: {
          fallback: 'error',
          children: {
            type: Suspense,
            props: {
              fallback: { type: BadFallback, props: {} },
              children: { type: Child, props: {} },
            },
          },
        },
      }),
      container,
    )

    await tick()
    expect(container.textContent).toBe('error')
    expect(mounted).toBe(0)
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
          resetKeys: reactive(() => reset()),
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

  it('calls onResolve for each reset pending cycle', async () => {
    const container = document.createElement('div')
    const shouldSuspend = createSignal(true)
    const reset = createSignal(0)
    const onResolve = vi.fn()
    let current = createSuspenseToken()

    const Child = () => {
      if (shouldSuspend()) {
        throw current.token
      }
      return { type: 'span', props: { children: `ready-${reset()}` } }
    }

    const dispose = render(
      () => ({
        type: Suspense,
        props: {
          fallback: 'loading',
          onResolve,
          resetKeys: reactive(() => reset()),
          children: { type: Child, props: {} },
        },
      }),
      container,
    )

    await tick()
    expect(container.textContent).toBe('loading')

    shouldSuspend(false)
    current.resolve()
    await tick()
    await tick()
    expect(container.textContent).toBe('ready-0')
    expect(onResolve).toHaveBeenCalledTimes(1)

    shouldSuspend(true)
    current = createSuspenseToken()
    reset(1)
    await tick()
    expect(container.textContent).toBe('loading')

    shouldSuspend(false)
    current.resolve()
    await tick()
    await tick()
    expect(container.textContent).toBe('ready-1')
    expect(onResolve).toHaveBeenCalledTimes(2)

    shouldSuspend(true)
    current = createSuspenseToken()
    reset(2)
    await tick()
    expect(container.textContent).toBe('loading')

    shouldSuspend(false)
    current.resolve()
    await tick()
    await tick()
    expect(container.textContent).toBe('ready-2')
    expect(onResolve).toHaveBeenCalledTimes(3)

    dispose()
  })

  it('ignores stale token resolution after resetKeys changes', async () => {
    const container = document.createElement('div')
    const shouldSuspend = createSignal(true)
    const reset = createSignal(0)
    const onResolve = vi.fn()
    const stale = createSuspenseToken()
    let current = stale

    const Child = () => {
      if (shouldSuspend()) {
        throw current.token
      }
      return { type: 'span', props: { children: 'ready' } }
    }

    const dispose = render(
      () => ({
        type: Suspense,
        props: {
          fallback: 'loading',
          onResolve,
          resetKeys: reactive(() => reset()),
          children: { type: Child, props: {} },
        },
      }),
      container,
    )

    await tick()
    expect(container.textContent).toBe('loading')

    current = createSuspenseToken()
    reset(1)
    await tick()
    expect(container.textContent).toBe('loading')

    stale.resolve()
    await tick()
    await tick()
    expect(container.textContent).toBe('loading')
    expect(onResolve).not.toHaveBeenCalled()

    shouldSuspend(false)
    current.resolve()
    await tick()
    await tick()
    expect(container.textContent).toBe('ready')
    expect(onResolve).toHaveBeenCalledTimes(1)

    dispose()
  })

  it('does not call onResolve for non-suspending initial or reset renders', async () => {
    const container = document.createElement('div')
    const reset = createSignal(0)
    const onResolve = vi.fn()

    const Child = () => ({ type: 'span', props: { children: `ready-${reset()}` } })

    const dispose = render(
      () => ({
        type: Suspense,
        props: {
          fallback: 'loading',
          onResolve,
          resetKeys: reactive(() => reset()),
          children: { type: Child, props: {} },
        },
      }),
      container,
    )

    await tick()
    expect(container.textContent).toBe('ready-0')
    expect(onResolve).not.toHaveBeenCalled()

    reset(1)
    await tick()
    expect(container.textContent).toBe('ready-1')
    expect(onResolve).not.toHaveBeenCalled()

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

  it('creates suspense markers in container ownerDocument', async () => {
    const foreignDoc = document.implementation.createHTMLDocument('foreign-suspense')
    const container = foreignDoc.createElement('div')
    const { token, resolve } = createSuspenseToken()

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
      container as unknown as HTMLElement,
    )

    await tick()
    const commentNodes = Array.from(container.childNodes).filter(
      node => node.nodeType === Node.COMMENT_NODE,
    ) as Comment[]
    const startMarker = commentNodes.find(node => node.data.startsWith('fict:suspense-start'))
    const endMarker = commentNodes.find(node => node.data.startsWith('fict:suspense-end'))
    expect(startMarker?.ownerDocument).toBe(foreignDoc)
    expect(endMarker?.ownerDocument).toBe(foreignDoc)

    resolve()
    await tick()
    await tick()

    dispose()
  })
})
