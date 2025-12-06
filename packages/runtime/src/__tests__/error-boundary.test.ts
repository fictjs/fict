import { describe, it, expect } from 'vitest'

import { bindEvent, createSignal, render, ErrorBoundary, Fragment, createEffect } from '../index'

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

    btn.dispatchEvent(new Event('click'))
    await nextTick()

    expect(captured).toBeInstanceOf(Error)
    expect(container.textContent).toBe('event-fallback')

    dispose()
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
})
