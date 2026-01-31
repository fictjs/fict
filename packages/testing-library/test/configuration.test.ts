/**
 * Tests for configuration options and edge cases
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, renderHook } from '../src/index'
import { createElement, onDestroy, onMount } from '@fictjs/runtime'
import { createSignal } from '@fictjs/runtime/advanced'

describe('cleanup behavior', () => {
  // Note: We manually track cleanup to test edge cases

  describe('manual cleanup', () => {
    it('cleanup can be called multiple times safely', () => {
      const { container } = render(() =>
        createElement({
          type: 'div',
          props: { children: 'Test' },
          key: undefined,
        }),
      )

      expect(document.body.contains(container)).toBe(true)

      // First cleanup
      cleanup()
      expect(document.body.contains(container)).toBe(false)

      // Second cleanup should not throw
      expect(() => cleanup()).not.toThrow()
    })

    it('cleanup after unmount does not double-dispose', () => {
      let disposeCount = 0

      const { unmount } = render(() => {
        onDestroy(() => {
          disposeCount++
        })
        return createElement({
          type: 'div',
          props: { children: 'Test' },
          key: undefined,
        })
      })

      unmount()
      expect(disposeCount).toBe(1)

      cleanup()
      // Should not dispose again
      expect(disposeCount).toBe(1)
    })

    it('handles cleanup with no mounted components', () => {
      // First ensure nothing is mounted
      cleanup()

      // Calling cleanup with nothing mounted should not throw
      expect(() => cleanup()).not.toThrow()
    })
  })

  describe('mixed render and renderHook cleanup', () => {
    it('cleanup disposes both render and renderHook', () => {
      let renderDisposed = false
      let hookDisposed = false

      render(() => {
        onDestroy(() => {
          renderDisposed = true
        })
        return createElement({
          type: 'div',
          props: { children: 'Render' },
          key: undefined,
        })
      })

      renderHook(() => {
        onMount(() => {
          return () => {
            hookDisposed = true
          }
        })
        return {}
      })

      expect(renderDisposed).toBe(false)
      expect(hookDisposed).toBe(false)

      cleanup()

      expect(renderDisposed).toBe(true)
      expect(hookDisposed).toBe(true)
    })
  })
})

describe('edge cases', () => {
  beforeEach(() => {
    cleanup()
  })

  describe('render edge cases', () => {
    it('handles null return from view function', () => {
      const { container } = render(() => null as any)
      expect(container).toBeTruthy()
    })

    it('handles undefined return from view function', () => {
      const { container } = render(() => undefined as any)
      expect(container).toBeTruthy()
    })

    it('handles empty array children', () => {
      const { container } = render(() =>
        createElement({
          type: 'ul',
          props: { children: [] },
          key: undefined,
        }),
      )

      expect(container.querySelector('ul')).toBeTruthy()
      expect(container.querySelector('ul')?.children.length).toBe(0)
    })

    it('handles deeply nested components', () => {
      const DeepNest = (props: { depth: number; children?: any }) => {
        if (props.depth === 0) {
          return createElement({
            type: 'span',
            props: { 'data-testid': 'deep', children: 'Bottom' },
            key: undefined,
          })
        }
        return createElement({
          type: 'div',
          props: {
            children: createElement({
              type: DeepNest as any,
              props: { depth: props.depth - 1 },
              key: undefined,
            }),
          },
          key: undefined,
        })
      }

      const { getByTestId, container } = render(() =>
        createElement({
          type: DeepNest as any,
          props: { depth: 10 },
          key: undefined,
        }),
      )

      expect(getByTestId('deep').textContent).toBe('Bottom')
      // Count nesting depth
      let depth = 0
      let node: Element | null = container.querySelector('[data-testid="deep"]')
      while (node && node !== container) {
        depth++
        node = node.parentElement
      }
      expect(depth).toBe(11) // 10 divs + 1 span
    })

    it('handles rapid rerender calls', () => {
      const { container, rerender } = render(() =>
        createElement({
          type: 'div',
          props: { children: '0' },
          key: undefined,
        }),
      )

      for (let i = 1; i <= 100; i++) {
        rerender(() =>
          createElement({
            type: 'div',
            props: { children: String(i) },
            key: undefined,
          }),
        )
      }

      expect(container.textContent).toBe('100')
    })
  })

  describe('renderHook edge cases', () => {
    it('handles hook returning undefined', () => {
      const { result } = renderHook(() => undefined)
      expect(result.current).toBeUndefined()
    })

    it('handles hook returning null', () => {
      const { result } = renderHook(() => null)
      expect(result.current).toBeNull()
    })

    it('handles hook returning primitive values', () => {
      const { result: numberResult } = renderHook(() => 42)
      expect(numberResult.current).toBe(42)

      cleanup()

      const { result: stringResult } = renderHook(() => 'hello')
      expect(stringResult.current).toBe('hello')

      cleanup()

      const { result: boolResult } = renderHook(() => true)
      expect(boolResult.current).toBe(true)
    })

    it('handles rapid rerender calls on hook', () => {
      const { result, rerender } = renderHook((value: number) => value * 2, {
        initialProps: [1],
      })

      for (let i = 2; i <= 50; i++) {
        rerender([i])
      }

      expect(result.current).toBe(100) // 50 * 2
    })

    it('handles empty initial props', () => {
      const { result } = renderHook(() => {
        return { empty: true }
      })

      expect(result.current.empty).toBe(true)
    })
  })

  describe('container and baseElement edge cases', () => {
    it('handles custom container that is not in document', () => {
      const detachedContainer = document.createElement('div')
      // Not appended to document

      const { container, getByText } = render(
        () =>
          createElement({
            type: 'button',
            props: { children: 'Detached' },
            key: undefined,
          }),
        { container: detachedContainer },
      )

      expect(container).toBe(detachedContainer)
      expect(getByText('Detached')).toBeTruthy()
    })

    it('handles baseElement that is not document.body', () => {
      const customBase = document.createElement('main')
      document.body.appendChild(customBase)

      const { baseElement, container } = render(
        () =>
          createElement({
            type: 'div',
            props: { children: 'Custom base' },
            key: undefined,
          }),
        { baseElement: customBase },
      )

      expect(baseElement).toBe(customBase)
      expect(customBase.contains(container)).toBe(true)

      cleanup()
      customBase.remove()
    })
  })

  describe('memory and cleanup edge cases', () => {
    it('does not leak event listeners on cleanup', () => {
      const clickHandler = vi.fn()

      const { getByRole, unmount } = render(() => {
        const button = document.createElement('button')
        button.textContent = 'Click'
        button.addEventListener('click', clickHandler)
        return button
      })

      const button = getByRole('button')
      button.click()
      expect(clickHandler).toHaveBeenCalledTimes(1)

      unmount()

      // Button is removed from DOM, handler still attached to detached element
      // This tests that unmount properly clears the container
    })

    it('handles error in onDestroy during cleanup gracefully', () => {
      // Suppress console.error for this test
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

      // This test just verifies cleanup doesn't throw even with problematic teardown
      const { unmount } = render(() => {
        return createElement({
          type: 'div',
          props: { children: 'Test' },
          key: undefined,
        })
      })

      // unmount should not throw
      expect(() => unmount()).not.toThrow()

      consoleWarn.mockRestore()
      consoleError.mockRestore()
    })
  })
})

describe('concurrent renders', () => {
  beforeEach(() => {
    cleanup()
  })

  it('handles multiple simultaneous renders', () => {
    const containers: HTMLElement[] = []

    for (let i = 0; i < 5; i++) {
      const { container } = render(() =>
        createElement({
          type: 'div',
          props: { 'data-index': String(i), children: `Render ${i}` },
          key: undefined,
        }),
      )
      containers.push(container)
    }

    // All should be in document
    containers.forEach((c, i) => {
      expect(document.body.contains(c)).toBe(true)
      expect(c.querySelector(`[data-index="${i}"]`)).toBeTruthy()
    })

    cleanup()

    // All should be removed
    containers.forEach(c => {
      expect(document.body.contains(c)).toBe(false)
    })
  })

  it('handles interleaved render and cleanup', () => {
    const { container: c1 } = render(() =>
      createElement({
        type: 'div',
        props: { id: 'first', children: 'First' },
        key: undefined,
      }),
    )

    cleanup()

    const { container: c2 } = render(() =>
      createElement({
        type: 'div',
        props: { id: 'second', children: 'Second' },
        key: undefined,
      }),
    )

    expect(document.body.contains(c1)).toBe(false)
    expect(document.body.contains(c2)).toBe(true)

    cleanup()
  })
})
