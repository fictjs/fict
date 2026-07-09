import { describe, it, expect, vi } from 'vitest'

import {
  Suspense,
  createSuspenseToken,
  render,
  ErrorBoundary,
  Fragment,
  onMount,
  createEffect,
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

  it('does not let a Suspense boundary catch sibling effect tokens', async () => {
    const sibling = createSuspenseToken()
    const trigger = createSignal(false)
    const container = document.createElement('div')

    const Outside = () => {
      createEffect(() => {
        if (trigger()) {
          throw sibling.token
        }
      })
      return { type: 'span', props: { children: 'outside' } }
    }

    const dispose = render(
      () => ({
        type: Suspense,
        props: {
          fallback: 'outer-fallback',
          children: {
            type: Fragment,
            props: {
              children: [
                {
                  type: Suspense,
                  props: {
                    fallback: 'inner-fallback',
                    children: { type: 'span', props: { children: 'inside' } },
                  },
                },
                { type: Outside, props: {} },
              ],
            },
          },
        },
      }),
      container,
    )

    expect(container.textContent).toBe('insideoutside')

    trigger(true)
    await tick()

    expect(container.textContent).toBe('outer-fallback')

    dispose()
  })

  it('does not let a Suspense boundary catch sibling render tokens', async () => {
    const sibling = createSuspenseToken()
    const show = createSignal(false)
    const container = document.createElement('div')

    const OutsideRender = () => {
      throw sibling.token
    }

    const dispose = render(
      () => ({
        type: Suspense,
        props: {
          fallback: 'outer-render-fallback',
          children: {
            type: Fragment,
            props: {
              children: [
                {
                  type: Suspense,
                  props: {
                    fallback: 'inner-render-fallback',
                    children: { type: 'span', props: { children: 'inside' } },
                  },
                },
                reactive(() =>
                  show()
                    ? { type: OutsideRender, props: {} }
                    : { type: 'span', props: { children: 'outside' } },
                ),
              ],
            },
          },
        },
      }),
      container,
    )

    expect(container.textContent).toBe('insideoutside')

    show(true)
    await tick()

    expect(container.textContent).toBe('outer-render-fallback')

    dispose()
  })

  it('keeps nested child tokens inside the inner Suspense boundary', async () => {
    const inner = createSuspenseToken()
    const trigger = createSignal(false)
    const container = document.createElement('div')

    const Inside = () => {
      createEffect(() => {
        if (trigger()) {
          throw inner.token
        }
      })
      return { type: 'span', props: { children: 'inside' } }
    }

    const dispose = render(
      () => ({
        type: Suspense,
        props: {
          fallback: 'outer-fallback',
          children: {
            type: Suspense,
            props: {
              fallback: 'inner-fallback',
              children: { type: Inside, props: {} },
            },
          },
        },
      }),
      container,
    )

    expect(container.textContent).toBe('inside')

    trigger(true)
    await tick()

    expect(container.textContent).toBe('inner-fallback')

    dispose()
  })

  it('does not catch sibling tokens after the Suspense boundary unmounts', async () => {
    const sibling = createSuspenseToken()
    const showInner = createSignal(true)
    const trigger = createSignal(false)
    const container = document.createElement('div')

    const Outside = () => {
      createEffect(() => {
        if (trigger()) {
          throw sibling.token
        }
      })
      return { type: 'span', props: { children: 'outside' } }
    }

    const dispose = render(
      () => ({
        type: Suspense,
        props: {
          fallback: 'outer-unmount-fallback',
          children: {
            type: Fragment,
            props: {
              children: [
                reactive(() =>
                  showInner()
                    ? {
                        type: Suspense,
                        props: {
                          fallback: 'inner-unmount-fallback',
                          children: { type: 'span', props: { children: 'inside' } },
                        },
                      }
                    : null,
                ),
                { type: Outside, props: {} },
              ],
            },
          },
        },
      }),
      container,
    )

    expect(container.textContent).toBe('insideoutside')

    showInner(false)
    await tick()
    expect(container.textContent).toBe('outside')

    trigger(true)
    await tick()

    expect(container.textContent).toBe('outer-unmount-fallback')

    dispose()
  })

  it('does not let same-host sibling Suspense ordering steal sibling tokens', async () => {
    const sibling = createSuspenseToken()
    const trigger = createSignal(false)
    const container = document.createElement('div')

    const Outside = () => {
      createEffect(() => {
        if (trigger()) {
          throw sibling.token
        }
      })
      return { type: 'span', props: { children: 'outside' } }
    }

    const dispose = render(
      () => ({
        type: Suspense,
        props: {
          fallback: 'outer-order-fallback',
          children: {
            type: Fragment,
            props: {
              children: [
                {
                  type: Suspense,
                  props: {
                    fallback: 'first-fallback',
                    children: { type: 'span', props: { children: 'first' } },
                  },
                },
                {
                  type: Suspense,
                  props: {
                    fallback: 'second-fallback',
                    children: { type: 'span', props: { children: 'second' } },
                  },
                },
                { type: Outside, props: {} },
              ],
            },
          },
        },
      }),
      container,
    )

    expect(container.textContent).toBe('firstsecondoutside')

    trigger(true)
    await tick()

    expect(container.textContent).toBe('outer-order-fallback')

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

  it('lets an outer Suspense capture a token thrown by its fallback', async () => {
    const childPending = createSuspenseToken()
    const fallbackPending = createSuspenseToken()
    const container = document.createElement('div')
    let fallbackRenders = 0

    const Child = () => {
      throw childPending.token
    }

    const PendingFallback = () => {
      fallbackRenders += 1
      throw fallbackPending.token
    }

    const dispose = render(
      () => ({
        type: Suspense,
        props: {
          fallback: 'outer loading',
          children: {
            type: Suspense,
            props: {
              fallback: { type: PendingFallback, props: {} },
              children: { type: Child, props: {} },
            },
          },
        },
      }),
      container,
    )

    await tick()
    expect(container.textContent).toBe('outer loading')
    expect(fallbackRenders).toBe(1)

    dispose()
  })

  it('bubbles a token thrown while evaluating a fallback function', async () => {
    const childPending = createSuspenseToken()
    const fallbackPending = createSuspenseToken()
    const container = document.createElement('div')
    let fallbackCalls = 0

    const Child = () => {
      throw childPending.token
    }

    const dispose = render(
      () => ({
        type: Suspense,
        props: {
          fallback: 'outer loading',
          children: {
            type: Suspense,
            props: {
              fallback: () => {
                fallbackCalls += 1
                throw fallbackPending.token
              },
              children: { type: Child, props: {} },
            },
          },
        },
      }),
      container,
    )

    await tick()
    expect(container.textContent).toBe('outer loading')
    expect(fallbackCalls).toBe(1)

    dispose()
  })

  it('keeps fallback effects outside their own Suspense capture scope', async () => {
    const childPending = createSuspenseToken()
    const fallbackPending = createSuspenseToken()
    const shouldSuspend = createSignal(false)
    const container = document.createElement('div')

    const Child = () => {
      throw childPending.token
    }

    const PendingFallback = () => {
      createEffect(() => {
        if (shouldSuspend()) throw fallbackPending.token
      })
      return 'inner loading'
    }

    const dispose = render(
      () => ({
        type: Suspense,
        props: {
          fallback: 'outer loading',
          children: {
            type: Suspense,
            props: {
              fallback: { type: PendingFallback, props: {} },
              children: { type: Child, props: {} },
            },
          },
        },
      }),
      container,
    )

    await tick()
    expect(container.textContent).toBe('inner loading')

    shouldSuspend(true)
    await tick()
    expect(container.textContent).toBe('outer loading')

    dispose()
  })

  it('lets an ErrorBoundary capture an error thrown by a Suspense fallback once', async () => {
    const { token } = createSuspenseToken()
    const container = document.createElement('div')
    const fallbackError = new Error('fallback failed')
    const captured: unknown[] = []
    let fallbackRenders = 0

    const Child = () => {
      throw token
    }

    const ThrowingFallback = () => {
      fallbackRenders += 1
      throw fallbackError
    }

    const dispose = render(
      () => ({
        type: ErrorBoundary,
        props: {
          fallback: 'error handled',
          onError: err => captured.push(err),
          children: {
            type: Suspense,
            props: {
              fallback: { type: ThrowingFallback, props: {} },
              children: { type: Child, props: {} },
            },
          },
        },
      }),
      container,
    )

    await tick()
    expect(container.textContent).toBe('error handled')
    expect(fallbackRenders).toBe(1)
    expect(captured).toEqual([fallbackError])

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
