/**
 * Tests for waitFor utility (re-exported from @testing-library/dom)
 *
 * Note: Fict uses fine-grained reactivity. Some tests use rerender or compiled
 * components to trigger DOM updates. The waitFor utility is primarily useful
 * for async operations or when using compiled $state/$effect macros.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, cleanup, waitFor, screen } from '../src/index'
import { createElement } from '@fictjs/runtime'

describe('waitFor', () => {
  beforeEach(() => {
    cleanup()
  })

  describe('basic usage', () => {
    it('waits for element to appear via rerender', async () => {
      const { container, rerender } = render(() =>
        createElement({
          type: 'div',
          props: { children: 'Loading...' },
          key: undefined,
        }),
      )

      expect(container.querySelector('[data-testid="delayed-element"]')).toBeNull()

      // Trigger the update after a delay
      setTimeout(() => {
        rerender(() =>
          createElement({
            type: 'div',
            props: { 'data-testid': 'delayed-element', children: 'Appeared!' },
            key: undefined,
          }),
        )
      }, 50)

      await waitFor(() => {
        expect(container.querySelector('[data-testid="delayed-element"]')).toBeTruthy()
      })
    })

    it('waits for text content to change via rerender', async () => {
      const { container, rerender } = render(() =>
        createElement({
          type: 'div',
          props: { children: 'Initial' },
          key: undefined,
        }),
      )

      expect(container.textContent).toBe('Initial')

      setTimeout(() => {
        rerender(() =>
          createElement({
            type: 'div',
            props: { children: 'Updated' },
            key: undefined,
          }),
        )
      }, 50)

      await waitFor(() => {
        expect(container.textContent).toBe('Updated')
      })
    })

    it('waits for element to be removed via rerender', async () => {
      const { queryByTestId, rerender } = render(() =>
        createElement({
          type: 'div',
          props: { 'data-testid': 'removable', children: 'I will disappear' },
          key: undefined,
        }),
      )

      expect(queryByTestId('removable')).toBeTruthy()

      setTimeout(() => {
        rerender(() =>
          createElement({
            type: 'div',
            props: { children: 'Gone' },
            key: undefined,
          }),
        )
      }, 50)

      await waitFor(() => {
        expect(queryByTestId('removable')).toBeNull()
      })
    })
  })

  describe('timeout behavior', () => {
    it('throws error when timeout is exceeded', async () => {
      await expect(
        waitFor(
          () => {
            expect(false).toBe(true)
          },
          { timeout: 100, interval: 20 },
        ),
      ).rejects.toThrow()
    })

    it('respects custom timeout', async () => {
      const startTime = Date.now()

      try {
        await waitFor(
          () => {
            throw new Error('Always fails')
          },
          { timeout: 150, interval: 30 },
        )
      } catch (e) {
        // Expected to fail
      }

      const elapsed = Date.now() - startTime
      expect(elapsed).toBeGreaterThanOrEqual(100)
      expect(elapsed).toBeLessThan(300)
    })

    it('resolves immediately if condition is met', async () => {
      const startTime = Date.now()

      await waitFor(() => {
        expect(true).toBe(true)
      })

      const elapsed = Date.now() - startTime
      expect(elapsed).toBeLessThan(100)
    })
  })

  describe('with DOM mutations', () => {
    it('waits for DOM attribute to change', async () => {
      const { getByTestId } = render(() => {
        const div = document.createElement('div')
        div.setAttribute('data-testid', 'element')
        div.setAttribute('data-status', 'loading')
        div.textContent = 'Element'
        return div
      })

      const element = getByTestId('element')

      setTimeout(() => {
        element.setAttribute('data-status', 'loaded')
      }, 50)

      await waitFor(() => {
        expect(element.getAttribute('data-status')).toBe('loaded')
      })
    })

    it('waits for child elements to be added', async () => {
      const { container } = render(() => {
        const ul = document.createElement('ul')
        ul.setAttribute('data-testid', 'list')
        return ul
      })

      const list = container.querySelector('[data-testid="list"]')!

      setTimeout(() => {
        for (let i = 0; i < 3; i++) {
          const li = document.createElement('li')
          li.textContent = `Item ${i + 1}`
          list.appendChild(li)
        }
      }, 50)

      await waitFor(() => {
        expect(list.querySelectorAll('li').length).toBe(3)
      })
    })
  })

  describe('with async operations', () => {
    it('waits for async DOM update', async () => {
      const { container } = render(() => {
        const div = document.createElement('div')
        div.textContent = 'Loading...'
        return div
      })

      // Simulate async data fetch that updates DOM directly
      Promise.resolve().then(() => {
        setTimeout(() => {
          container.querySelector('div')!.textContent = 'Loaded data'
        }, 50)
      })

      await waitFor(() => {
        expect(container.textContent).toBe('Loaded data')
      })
    })
  })

  describe('error messages', () => {
    it('provides descriptive error on timeout', async () => {
      try {
        await waitFor(
          () => {
            throw new Error('Custom failure message')
          },
          { timeout: 50 },
        )
        expect.fail('Should have thrown')
      } catch (error) {
        expect((error as Error).message).toContain('Custom failure message')
      }
    })

    it('re-throws assertion errors with context', async () => {
      const { container } = render(() =>
        createElement({
          type: 'div',
          props: { children: 'Actual' },
          key: undefined,
        }),
      )

      try {
        await waitFor(
          () => {
            expect(container.textContent).toBe('Expected')
          },
          { timeout: 50 },
        )
        expect.fail('Should have thrown')
      } catch (error) {
        expect((error as Error).message).toContain('Expected')
      }
    })
  })

  describe('with rerender pattern', () => {
    it('supports pattern of rerender + waitFor for state changes', async () => {
      let currentState = 0
      const renderContent = () =>
        createElement({
          type: 'div',
          props: { 'data-testid': 'counter', children: String(currentState) },
          key: undefined,
        })

      const { getByTestId, rerender } = render(renderContent)

      expect(getByTestId('counter').textContent).toBe('0')

      // Simulate async state update
      setTimeout(() => {
        currentState = 5
        rerender(renderContent)
      }, 50)

      await waitFor(() => {
        expect(getByTestId('counter').textContent).toBe('5')
      })
    })
  })
})
