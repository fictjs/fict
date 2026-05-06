import { describe, it, expect } from 'vitest'

import { render, ErrorBoundary, Fragment, createEffect, onMount, onDestroy } from '../src/index'
import { createRenderEffect, createSignal, reactive } from '../src/advanced'
import { bindEvent, createKeyedList, spread } from '../src/internal'

const nextTick = () => Promise.resolve()

const Thrower = () => {
  throw new Error('boom')
}

describe('ErrorBoundary', () => {
  it('captures render errors and shows fallback', async () => {
    const container = document.createElement('div')
    let captured: unknown = null

    const dispose = render(
      () => ({
        type: ErrorBoundary,
        props: {
          fallback: 'fallback',
          onError: err => {
            captured = err
          },
          children: { type: Thrower, props: {} },
        },
      }),
      container,
    )

    await nextTick()
    expect(captured).toBeInstanceOf(Error)
    expect(container.textContent).toBe('fallback')

    dispose()
  })

  it('creates boundary marker in container ownerDocument', async () => {
    const foreignDoc = document.implementation.createHTMLDocument('foreign-error-boundary')
    const container = foreignDoc.createElement('div')

    const dispose = render(
      () => ({
        type: ErrorBoundary,
        props: {
          fallback: 'fallback',
          children: { type: 'span', props: { children: 'ok' } },
        },
      }),
      container as unknown as HTMLElement,
    )

    await nextTick()
    const marker = Array.from(container.childNodes).find(
      node =>
        node.nodeType === Node.COMMENT_NODE && (node as Comment).data === 'fict:error-boundary',
    ) as Comment | undefined
    expect(marker).toBeTruthy()
    expect(marker?.ownerDocument).toBe(foreignDoc)

    dispose()
  })

  it('does not run onMount when render fails', async () => {
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
        props: { fallback: 'fb', children: { type: Bad, props: {} } },
      }),
      container,
    )

    await nextTick()
    expect(container.textContent).toBe('fb')
    expect(mounted).toBe(0)
  })

  it('does not run onMount when fallback render fails', async () => {
    const container = document.createElement('div')
    let mounted = 0

    const Crash = () => {
      throw new Error('boom')
    }

    const BadFallback = () => {
      onMount(() => {
        mounted += 1
      })
      throw new Error('fallback boom')
    }

    render(
      () => ({
        type: ErrorBoundary,
        props: {
          fallback: 'outer',
          children: {
            type: ErrorBoundary,
            props: {
              fallback: { type: BadFallback, props: {} },
              children: { type: Crash, props: {} },
            },
          },
        },
      }),
      container,
    )

    await nextTick()
    expect(container.textContent).toBe('outer')
    expect(mounted).toBe(0)
  })

  it('exposes reset to fallback and restores children', async () => {
    const container = document.createElement('div')
    const shouldThrow = createSignal(true)
    let resetFn: (() => void) | undefined

    const MaybeThrow = () => {
      if (shouldThrow()) {
        throw new Error('boom')
      }
      return { type: 'span', props: { children: 'ok' } }
    }

    render(
      () => ({
        type: ErrorBoundary,
        props: {
          fallback: (_err, reset) => {
            resetFn = reset
            return { type: 'button', props: { children: 'retry' } }
          },
          children: { type: MaybeThrow, props: {} },
        },
      }),
      container,
    )

    await nextTick()
    expect(container.textContent).toBe('retry')
    expect(resetFn).toBeTypeOf('function')

    shouldThrow(false)
    resetFn?.()
    await nextTick()

    expect(container.textContent).toBe('ok')
  })

  it('captures effect errors and switches to fallback', async () => {
    const container = document.createElement('div')
    const trigger = createSignal(0)

    const ThrowInEffect = () => {
      createEffect(() => {
        if (trigger() > 0) {
          throw new Error('effect boom')
        }
      })
      return { type: 'span', props: { children: 'ok' } }
    }

    const dispose = render(
      () => ({
        type: ErrorBoundary,
        props: {
          fallback: 'eff-fallback',
          children: { type: ThrowInEffect, props: {} },
        },
      }),
      container,
    )

    expect(container.textContent).toBe('ok')

    trigger(1)
    await nextTick()

    expect(container.textContent).toBe('eff-fallback')

    dispose()
  })

  it('captures effect cleanup errors and switches to fallback', async () => {
    const container = document.createElement('div')
    const trigger = createSignal(0)
    let captured: unknown = null
    let shouldThrow = false

    const ThrowInCleanup = () => {
      createEffect(() => {
        trigger()
        return () => {
          if (shouldThrow) {
            throw new Error('cleanup boom')
          }
        }
      })
      return { type: 'span', props: { children: 'ok' } }
    }

    const dispose = render(
      () => ({
        type: ErrorBoundary,
        props: {
          fallback: 'cleanup-fallback',
          onError: err => {
            captured = err
          },
          children: { type: ThrowInCleanup, props: {} },
        },
      }),
      container,
    )

    expect(container.textContent).toBe('ok')

    shouldThrow = true
    trigger(1)
    await nextTick()

    expect(captured).toBeInstanceOf(Error)
    expect((captured as Error).message).toBe('cleanup boom')
    expect(container.textContent).toBe('cleanup-fallback')

    dispose()
  })

  it('captures render effect cleanup errors and switches to fallback', async () => {
    const container = document.createElement('div')
    const trigger = createSignal(0)
    let captured: unknown = null
    let shouldThrow = false

    const ThrowInRenderCleanup = () => {
      createRenderEffect(() => {
        trigger()
        return () => {
          if (shouldThrow) {
            throw new Error('render cleanup boom')
          }
        }
      })
      return { type: 'span', props: { children: 'ok' } }
    }

    const dispose = render(
      () => ({
        type: ErrorBoundary,
        props: {
          fallback: 'render-cleanup-fallback',
          onError: err => {
            captured = err
          },
          children: { type: ThrowInRenderCleanup, props: {} },
        },
      }),
      container,
    )

    expect(container.textContent).toBe('ok')

    shouldThrow = true
    trigger(1)
    await nextTick()

    expect(captured).toBeInstanceOf(Error)
    expect((captured as Error).message).toBe('render cleanup boom')
    expect(container.textContent).toBe('render-cleanup-fallback')

    dispose()
  })

  it('captures cleanup errors during root dispose', async () => {
    const container = document.createElement('div')
    let captured: unknown = null

    const ThrowOnDisposeCleanup = () => {
      createEffect(() => () => {
        throw new Error('dispose cleanup boom')
      })
      return { type: 'span', props: { children: 'ok' } }
    }

    const dispose = render(
      () => ({
        type: ErrorBoundary,
        props: {
          fallback: 'dispose-fallback',
          onError: err => {
            captured = err
          },
          children: { type: ThrowOnDisposeCleanup, props: {} },
        },
      }),
      container,
    )

    expect(() => dispose()).not.toThrow()
    expect(captured).toBeInstanceOf(Error)
    expect((captured as Error).message).toBe('dispose cleanup boom')
  })

  it('captures onDestroy errors when a subtree unmounts', async () => {
    const container = document.createElement('div')
    const show = createSignal(true)
    let captured: unknown = null

    const ThrowOnDestroy = () => {
      onDestroy(() => {
        throw new Error('destroy boom')
      })
      return { type: 'span', props: { children: 'child-ok' } }
    }

    const dispose = render(
      () => ({
        type: ErrorBoundary,
        props: {
          fallback: 'destroy-fallback',
          onError: err => {
            captured = err
          },
          children: {
            type: 'div',
            props: {
              children: reactive(() => (show() ? { type: ThrowOnDestroy, props: {} } : null)),
            },
          },
        },
      }),
      container,
    )

    expect(container.textContent).toBe('child-ok')

    show(false)
    await nextTick()

    expect(captured).toBeInstanceOf(Error)
    expect((captured as Error).message).toBe('destroy boom')
    expect(container.textContent).toBe('destroy-fallback')

    dispose()
  })

  it('captures event errors', async () => {
    const container = document.createElement('div')
    // Attach container to document.body for event delegation to work
    document.body.appendChild(container)

    const btn = document.createElement('button')
    let captured: unknown = null

    const App = () => {
      bindEvent(btn, 'click', (event: Event) => {
        void event
        throw new Error('event boom')
      })
      return {
        type: Fragment,
        props: {
          children: {
            type: ErrorBoundary,
            props: {
              fallback: 'event-fallback',
              onError: err => {
                captured = err
              },
              children: btn,
            },
          },
        },
      }
    }

    const dispose = render(() => ({ type: App, props: {} }), container)

    expect(container.textContent).toBe('')

    // Use bubbles: true for proper event propagation with delegation
    btn.dispatchEvent(new Event('click', { bubbles: true }))
    await nextTick()

    expect(captured).toBeInstanceOf(Error)
    expect(container.textContent).toBe('event-fallback')

    dispose()
    // Clean up
    document.body.removeChild(container)
  })

  it('captures spread event errors', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    let captured: unknown = null

    const SpreadButton = () => {
      const button = document.createElement('button')
      button.textContent = 'spread'
      spread(
        button,
        {
          onClick: () => {
            throw new Error('spread event boom')
          },
        },
        false,
        true,
      )
      return button
    }

    const dispose = render(
      () => ({
        type: ErrorBoundary,
        props: {
          fallback: 'spread-fallback',
          onError: err => {
            captured = err
          },
          children: { type: SpreadButton, props: {} },
        },
      }),
      container,
    )

    const button = container.querySelector('button') as HTMLButtonElement
    button.dispatchEvent(new Event('click', { bubbles: true }))
    await nextTick()

    expect(captured).toBeInstanceOf(Error)
    expect((captured as Error).message).toBe('spread event boom')
    expect(container.textContent).toBe('spread-fallback')

    dispose()
    document.body.removeChild(container)
  })

  it('resets on resetKeys change', async () => {
    const container = document.createElement('div')
    const shouldThrow = createSignal(true)
    const resetKey = createSignal(0)

    const MaybeThrow = () => {
      if (shouldThrow()) {
        throw new Error('render boom')
      }
      return { type: 'span', props: { children: 'recovered' } }
    }

    const dispose = render(
      () => ({
        type: ErrorBoundary,
        props: {
          fallback: 'render-fallback',
          resetKeys: reactive(() => resetKey()),
          children: { type: MaybeThrow, props: {} },
        },
      }),
      container,
    )

    await nextTick()
    expect(container.textContent).toBe('render-fallback')

    shouldThrow(false)
    resetKey(1)
    await nextTick()

    expect(container.textContent).toBe('recovered')

    dispose()
  })

  it('does not remove sibling nodes when rendering fallback', () => {
    const Crash = () => {
      throw new Error('boom')
    }
    const container = document.createElement('div')
    render(
      () => ({
        type: 'div',
        props: {
          children: [
            { type: 'span', props: { children: 'left' } },
            {
              type: ErrorBoundary,
              props: { fallback: 'error', children: { type: Crash, props: {} } },
            },
            { type: 'span', props: { children: 'right' } },
          ],
        },
      }),
      container,
    )

    expect(container.textContent).toBe('lefterrorright')
  })

  it('renders fallback and triggers onError', () => {
    const order: string[] = []
    const Crash = () => {
      throw new Error('boom')
    }
    const container = document.createElement('div')
    render(
      () => ({
        type: ErrorBoundary,
        props: {
          fallback: () => {
            order.push('fallback')
            return 'oops'
          },
          onError: () => {
            order.push(container.textContent || '')
          },
          children: { type: Crash, props: {} },
        },
      }),
      container,
    )

    expect(container.textContent).toBe('oops')
    expect(order[0]).toBe('fallback')
    expect(order[1]).toBeDefined()
  })

  it('captures errors from dynamic child bindings during updates', async () => {
    const container = document.createElement('div')
    const show = createSignal(false)

    const ThrowingChild = () => {
      throw new Error('dynamic boom')
    }

    const dispose = render(
      () => ({
        type: ErrorBoundary,
        props: {
          fallback: 'dyn-fallback',
          children: {
            type: 'div',
            props: {
              children: reactive(() =>
                show()
                  ? { type: ThrowingChild, props: {} }
                  : { type: 'span', props: { children: 'ok' } },
              ),
            },
          },
        },
      }),
      container,
    )

    await nextTick()
    expect(container.textContent).toBe('ok')

    show(true)
    await nextTick()

    expect(container.textContent).toBe('dyn-fallback')

    dispose()
  })

  it('captures errors from keyed list blocks created after updates', async () => {
    const container = document.createElement('div')
    // Attach to document.body for isConnected check in performDiff
    document.body.appendChild(container)
    const items = createSignal([{ id: 1, label: 'safe' }])

    const List = () =>
      createKeyedList(
        () => items(),
        item => item.id,
        itemSig => {
          const value = itemSig()
          if (value.id === 2) {
            throw new Error('list boom')
          }
          const span = document.createElement('span')
          span.textContent = value.label
          return [span]
        },
      )

    const dispose = render(
      () => ({
        type: ErrorBoundary,
        props: {
          fallback: 'list-fallback',
          children: { type: List, props: {} },
        },
      }),
      container,
    )

    await nextTick()
    expect(container.textContent).toBe('safe')

    items([{ id: 2, label: 'boom' }])
    await nextTick()

    expect(container.textContent).toBe('list-fallback')

    dispose()
    // Clean up from document.body
    document.body.removeChild(container)
  })
})
