/**
 * Tests for Suspense testing utilities
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderWithSuspense, createTestSuspenseToken, cleanup, flush, render } from '../src/index'
import { createElement, Suspense, createSuspenseToken } from '@fictjs/runtime'
import type { FictNode } from '@fictjs/runtime'

const tick = () =>
  new Promise<void>(resolve =>
    typeof queueMicrotask === 'function'
      ? queueMicrotask(resolve)
      : Promise.resolve().then(resolve),
  )

describe('createTestSuspenseToken', () => {
  it('creates a suspense token with resolve and reject', () => {
    const { token, resolve, reject } = createTestSuspenseToken()

    expect(token).toBeDefined()
    expect(token.then).toBeDefined()
    expect(typeof resolve).toBe('function')
    expect(typeof reject).toBe('function')
  })

  it('token is thenable', async () => {
    const { token, resolve } = createTestSuspenseToken()

    let resolved = false
    token.then(() => {
      resolved = true
    })

    resolve()
    await tick()

    expect(resolved).toBe(true)
  })

  it('token can be rejected', async () => {
    const { token, reject } = createTestSuspenseToken()

    let rejected = false
    let error: unknown
    token.then(
      () => {},
      (err: unknown) => {
        rejected = true
        error = err
      },
    )

    reject(new Error('Test rejection'))
    await tick()

    expect(rejected).toBe(true)
    expect(error).toBeInstanceOf(Error)
  })
})

describe('renderWithSuspense', () => {
  beforeEach(() => {
    cleanup()
  })

  describe('basic rendering', () => {
    it('renders children when not suspended', () => {
      const { container } = renderWithSuspense(() =>
        createElement({
          type: 'div',
          props: { children: 'Loaded content' },
          key: undefined,
        }),
      )

      expect(container.textContent).toBe('Loaded content')
    })

    it('renders with custom fallback', () => {
      const { container } = renderWithSuspense(
        () =>
          createElement({
            type: 'div',
            props: { children: 'Content' },
            key: undefined,
          }),
        {
          fallback: createElement({
            type: 'div',
            props: { 'data-testid': 'suspense-fallback', children: 'Loading...' },
            key: undefined,
          }),
        },
      )

      expect(container.textContent).toBe('Content')
    })

    it('provides query utilities', () => {
      const { getByText, queryByText } = renderWithSuspense(() =>
        createElement({
          type: 'button',
          props: { children: 'Click me' },
          key: undefined,
        }),
      )

      expect(getByText('Click me')).toBeTruthy()
      expect(queryByText('Not here')).toBeNull()
    })
  })

  describe('isShowingFallback', () => {
    it('returns false when not suspended', () => {
      const { isShowingFallback } = renderWithSuspense(() =>
        createElement({
          type: 'div',
          props: { children: 'Content' },
          key: undefined,
        }),
      )

      expect(isShowingFallback()).toBe(false)
    })
  })

  describe('waitForResolution', () => {
    it('resolves immediately if component does not suspend', async () => {
      const { waitForResolution } = renderWithSuspense(() =>
        createElement({
          type: 'div',
          props: { children: 'Already loaded' },
          key: undefined,
        }),
      )

      // Should resolve quickly
      const start = Date.now()
      await waitForResolution()
      const elapsed = Date.now() - start

      expect(elapsed).toBeLessThan(100)
    })
  })

  describe('cleanup', () => {
    it('cleans up suspense boundary on unmount', () => {
      const { unmount, container } = renderWithSuspense(() =>
        createElement({
          type: 'div',
          props: { children: 'Content' },
          key: undefined,
        }),
      )

      expect(container.textContent).toBe('Content')

      unmount()

      expect(container.innerHTML).toBe('')
    })
  })

  describe('rerender', () => {
    it('can rerender with new content', () => {
      const { container, rerender } = renderWithSuspense(() =>
        createElement({
          type: 'div',
          props: { children: 'Original' },
          key: undefined,
        }),
      )

      expect(container.textContent).toBe('Original')

      rerender(() =>
        createElement({
          type: 'div',
          props: { children: 'Updated' },
          key: undefined,
        }),
      )

      expect(container.textContent).toBe('Updated')
    })
  })
})

describe('Suspense direct usage', () => {
  beforeEach(() => {
    cleanup()
  })

  it('renders Suspense directly without suspending', () => {
    const { container } = render(() =>
      createElement({
        type: Suspense as unknown as (props: Record<string, unknown>) => FictNode,
        props: {
          fallback: createElement({
            type: 'div',
            props: { children: 'Loading...' },
            key: undefined,
          }),
          children: createElement({
            type: 'div',
            props: { children: 'Content' },
            key: undefined,
          }),
        },
        key: undefined,
      }),
    )

    expect(container.textContent).toBe('Content')
  })

  // Note: Testing Suspense with suspending children requires JSX compilation
  // because createElement evaluates children immediately. In compiled JSX,
  // children are passed as VNodes and rendered inside the boundary.
  // See compiler.compiled.test.tsx for compiled component tests.
})
