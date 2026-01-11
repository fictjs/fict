import { describe, it, expect } from 'vitest'

import { render, ErrorBoundary, Fragment, createEffect } from '../src/index'
import { createSignal } from '../src/advanced'
import { bindEvent, createKeyedList } from '../src/internal'

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
          resetKeys: () => resetKey(),
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
              children: () =>
                show()
                  ? { type: ThrowingChild, props: {} }
                  : { type: 'span', props: { children: 'ok' } },
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
