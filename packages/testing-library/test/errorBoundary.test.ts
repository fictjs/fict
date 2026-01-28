/**
 * Tests for ErrorBoundary testing utilities
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderWithErrorBoundary, cleanup, render } from '../src/index'
import { createElement, ErrorBoundary } from '@fictjs/runtime'
import type { FictNode } from '@fictjs/runtime'

describe('renderWithErrorBoundary', () => {
  beforeEach(() => {
    cleanup()
  })

  describe('basic rendering', () => {
    it('renders children when no error occurs', () => {
      const { container } = renderWithErrorBoundary(() =>
        createElement({
          type: 'div',
          props: { children: 'Hello World' },
          key: undefined,
        }),
      )

      expect(container.textContent).toBe('Hello World')
    })

    it('renders with custom fallback element', () => {
      const { container } = renderWithErrorBoundary(
        () =>
          createElement({
            type: 'div',
            props: { children: 'Content' },
            key: undefined,
          }),
        {
          fallback: createElement({
            type: 'div',
            props: { 'data-testid': 'custom-fallback', children: 'Custom fallback' },
            key: undefined,
          }),
        },
      )

      expect(container.textContent).toBe('Content')
    })

    it('provides query utilities', () => {
      const { getByText, queryByText } = renderWithErrorBoundary(() =>
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
    it('returns false when no error', () => {
      const { isShowingFallback } = renderWithErrorBoundary(() =>
        createElement({
          type: 'div',
          props: { children: 'Content' },
          key: undefined,
        }),
      )

      expect(isShowingFallback()).toBe(false)
    })
  })

  // Note: triggerError uses rerender with a throwing component, which has
  // similar limitations to direct ErrorBoundary usage with createElement.
  // For proper error boundary testing with thrown errors, use compiled JSX.

  describe('cleanup', () => {
    it('cleans up error boundary on unmount', () => {
      const { unmount, container } = renderWithErrorBoundary(() =>
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
      const { container, rerender } = renderWithErrorBoundary(() =>
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

describe('ErrorBoundary direct usage', () => {
  beforeEach(() => {
    cleanup()
  })

  it('renders ErrorBoundary directly with non-throwing children', () => {
    const { container } = render(() =>
      createElement({
        type: ErrorBoundary as unknown as (props: Record<string, unknown>) => FictNode,
        props: {
          fallback: createElement({
            type: 'div',
            props: { children: 'Fallback' },
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

  // Note: Testing ErrorBoundary with throwing children requires JSX compilation
  // because createElement evaluates children immediately. In compiled JSX,
  // children are passed as VNodes and rendered inside the boundary.
  // See compiler.compiled.test.tsx for compiled component tests.
})
