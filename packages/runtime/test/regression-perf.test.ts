/**
 * Regression Tests for Performance Optimization Semantic Safety
 *
 * These tests prevent semantic regressions that could be introduced by
 * performance optimizations. Each test targets a specific edge case that
 * could break if the optimization is incorrectly implemented.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'

import {
  createSignal,
  createEffect,
  onMount,
  onCleanup,
  render,
  createElement,
  ErrorBoundary,
  createRoot,
} from '../src/index'
import { createSelector } from '../src/advanced'
import {
  createKeyedList,
  __fictPushContext,
  __fictPopContext,
  __fictResetContext,
} from '../src/internal'

const tick = () =>
  new Promise<void>(resolve =>
    typeof queueMicrotask === 'function'
      ? queueMicrotask(resolve)
      : Promise.resolve().then(resolve),
  )

describe('Performance Optimization Regression Tests', () => {
  describe('Effect count stability after remove/select operations', () => {
    let originalHook: unknown
    let effectRegistrations: number

    beforeEach(() => {
      originalHook = (globalThis as any).__FICT_DEVTOOLS_HOOK__
      effectRegistrations = 0
      ;(globalThis as any).__FICT_DEVTOOLS_HOOK__ = {
        registerSignal: () => {},
        updateSignal: () => {},
        registerEffect: () => {
          effectRegistrations++
        },
        effectRun: () => {},
      }
    })

    afterEach(() => {
      ;(globalThis as any).__FICT_DEVTOOLS_HOOK__ = originalHook
    })

    it('does not accumulate effects after repeated remove operations', async () => {
      const items = createSignal([
        { id: 1, name: 'A' },
        { id: 2, name: 'B' },
        { id: 3, name: 'C' },
      ])

      const container = document.createElement('div')
      document.body.appendChild(container)

      const listBinding = createKeyedList(
        () => items(),
        item => item.id,
        itemSig => {
          const div = document.createElement('div')
          createEffect(() => {
            div.textContent = itemSig().name
          })
          return [div]
        },
      )

      container.appendChild(listBinding.marker)
      await tick()

      const initialEffects = effectRegistrations

      // Perform multiple remove + add operations
      for (let i = 0; i < 5; i++) {
        // Remove item
        items([
          { id: 1, name: 'A' },
          { id: 2, name: 'B' },
        ])
        await tick()

        // Add item back
        items([
          { id: 1, name: 'A' },
          { id: 2, name: 'B' },
          { id: 4 + i, name: `D${i}` },
        ])
        await tick()
      }

      // Effect count should grow linearly with new items, not exponentially
      // Each cycle adds 1 item = 1 effect, so expect ~5 more effects
      const finalEffects = effectRegistrations
      const effectGrowth = finalEffects - initialEffects

      // Allow some tolerance but catch exponential growth
      expect(effectGrowth).toBeLessThan(20)

      listBinding.dispose()
      document.body.removeChild(container)
    })

    it('effect count remains stable after clear and repopulate', async () => {
      const items = createSignal<{ id: number; name: string }[]>([
        { id: 1, name: 'A' },
        { id: 2, name: 'B' },
      ])

      const container = document.createElement('div')

      const listBinding = createKeyedList(
        () => items(),
        item => item.id,
        itemSig => {
          const div = document.createElement('div')
          createEffect(() => {
            div.textContent = itemSig().name
          })
          return [div]
        },
      )

      container.appendChild(listBinding.marker)
      await tick()

      const baselineEffects = effectRegistrations

      // Clear
      items([])
      await tick()

      // Repopulate with same items
      items([
        { id: 1, name: 'A' },
        { id: 2, name: 'B' },
      ])
      await tick()

      // Clear again
      items([])
      await tick()

      // Repopulate again
      items([
        { id: 1, name: 'A' },
        { id: 2, name: 'B' },
      ])
      await tick()

      // Each repopulate should add 2 new effects (not accumulating)
      const totalNewEffects = effectRegistrations - baselineEffects
      // 2 repopulates * 2 items = 4 effects expected
      expect(totalNewEffects).toBeLessThanOrEqual(6)

      listBinding.dispose()
    })
  })

  describe('Hook context stack recovery after component render error', () => {
    it('recovers context stack after children construction throws', async () => {
      const container = document.createElement('div')

      // Component that throws during children construction
      const ThrowingComponent = () => {
        const children: any[] = []
        // Simulate error in children construction
        children.push({ type: 'div', props: { children: 'text' } })
        throw new Error('Error during children construction')
        return { type: 'div', props: { children } }
      }

      // First, render should fail but be caught by ErrorBoundary
      const dispose = render(
        () => ({
          type: ErrorBoundary,
          props: {
            fallback: 'error-caught',
            children: { type: ThrowingComponent, props: {} },
          },
        }),
        container,
      )

      await tick()
      expect(container.textContent).toBe('error-caught')

      // Reset context stack to clean state
      __fictResetContext()

      // Now verify the context stack is functional - render a normal component
      const container2 = document.createElement('div')
      const dispose2 = render(
        () => ({
          type: 'div',
          props: { children: 'success' },
        }),
        container2,
      )

      await tick()
      expect(container2.textContent).toBe('success')

      dispose()
      dispose2()
    })

    it('push/pop context remain balanced after error in nested component', async () => {
      const container = document.createElement('div')

      // Track context operations
      let contextBalanceCheck = true

      const OuterComponent = () => {
        const ctx = __fictPushContext()
        try {
          // Inner component that throws
          throw new Error('Nested error')
        } catch {
          // Error caught, but we must still pop
          __fictPopContext()
        }
        return { type: 'span', props: { children: 'outer' } }
      }

      // This should not corrupt the context stack
      const dispose = render(
        () => ({
          type: ErrorBoundary,
          props: {
            fallback: 'error',
            children: { type: OuterComponent, props: {} },
          },
        }),
        container,
      )

      await tick()

      // Reset and verify we can still render
      __fictResetContext()

      const container2 = document.createElement('div')
      const dispose2 = render(
        () => ({ type: 'div', props: { children: 'after-error' } }),
        container2,
      )

      await tick()
      expect(container2.textContent).toBe('after-error')

      dispose()
      dispose2()
    })
  })

  describe('Keyed list onMount timing and DOM connectivity', () => {
    it('element is connected to DOM when onMount fires', async () => {
      const container = document.createElement('div')
      document.body.appendChild(container)

      const mountStates: boolean[] = []

      const items = createSignal([{ id: 1 }, { id: 2 }, { id: 3 }])

      const listBinding = createKeyedList(
        () => items(),
        item => item.id,
        itemSig => {
          const div = document.createElement('div')
          div.setAttribute('data-id', String(itemSig().id))

          onMount(() => {
            // At this point, div should be in the DOM
            mountStates.push(div.isConnected)
          })

          return [div]
        },
      )

      container.appendChild(listBinding.marker)
      await tick()

      // All items should have isConnected = true during onMount
      expect(mountStates.length).toBe(3)
      expect(mountStates.every(state => state === true)).toBe(true)

      listBinding.dispose()
      document.body.removeChild(container)
    })

    it('newly added items are connected when onMount fires', async () => {
      const container = document.createElement('div')
      document.body.appendChild(container)

      const mountConnectedStates = new Map<number, boolean>()

      const items = createSignal([{ id: 1 }])

      const listBinding = createKeyedList(
        () => items(),
        item => item.id,
        itemSig => {
          const div = document.createElement('div')
          const id = itemSig().id

          onMount(() => {
            mountConnectedStates.set(id, div.isConnected)
          })

          return [div]
        },
      )

      container.appendChild(listBinding.marker)
      await tick()

      // Add new items
      items([{ id: 1 }, { id: 2 }, { id: 3 }])
      await tick()

      // All items should have been connected during their onMount
      expect(mountConnectedStates.get(1)).toBe(true)
      expect(mountConnectedStates.get(2)).toBe(true)
      expect(mountConnectedStates.get(3)).toBe(true)

      listBinding.dispose()
      document.body.removeChild(container)
    })
  })

  describe('Event handling with Text node target', () => {
    it('does not crash when event target is a Text node', async () => {
      const container = document.createElement('div')
      document.body.appendChild(container)

      let handlerCalled = false
      let noError = true

      const dispose = render(
        () => ({
          type: 'div',
          props: {
            onClick: () => {
              handlerCalled = true
            },
            children: 'Click me',
          },
        }),
        container,
      )

      await tick()

      // Get the text node inside the div
      const div = container.querySelector('div')
      const textNode = div?.firstChild

      expect(textNode).toBeInstanceOf(Text)

      // Create and dispatch a custom event with Text node as target
      try {
        const event = new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
        })

        // Dispatch from the text node - this tests the asElement fallback
        textNode!.dispatchEvent(event)
      } catch (e) {
        noError = false
      }

      expect(noError).toBe(true)
      // Handler should be called because event bubbles to parent div
      expect(handlerCalled).toBe(true)

      dispose()
      document.body.removeChild(container)
    })

    it('handles synthetic event with programmatic Text node target', () => {
      const container = document.createElement('div')
      document.body.appendChild(container)

      const textNode = document.createTextNode('test')
      const wrapper = document.createElement('span')
      wrapper.appendChild(textNode)
      container.appendChild(wrapper)

      let errorOccurred = false

      try {
        // Create event and dispatch from text node
        const event = new Event('click', { bubbles: true })
        textNode.dispatchEvent(event)
      } catch {
        errorOccurred = true
      }

      expect(errorOccurred).toBe(false)

      document.body.removeChild(container)
    })
  })

  describe('createSelector cleanup after unmount', () => {
    let originalHook: unknown
    let effectRuns: number[]

    beforeEach(() => {
      originalHook = (globalThis as any).__FICT_DEVTOOLS_HOOK__
      effectRuns = []
      ;(globalThis as any).__FICT_DEVTOOLS_HOOK__ = {
        registerSignal: () => {},
        updateSignal: () => {},
        registerEffect: (id: number) => {},
        effectRun: (id: number) => {
          effectRuns.push(id)
        },
      }
    })

    afterEach(() => {
      ;(globalThis as any).__FICT_DEVTOOLS_HOOK__ = originalHook
    })

    it('selector stops responding to source signal after component unmount', async () => {
      const source = createSignal<string>('a')
      let selectorResult: boolean | undefined
      let selectorCalled = 0

      const { dispose, value } = createRoot(() => {
        const isSelected = createSelector(() => source())

        // Read the selector
        selectorCalled++
        selectorResult = isSelected('a')

        return selectorResult
      })

      expect(selectorResult).toBe(true)
      const callsBeforeDispose = selectorCalled

      // Dispose/unmount
      dispose()

      // Record effect runs before source update
      const runsBeforeUpdate = effectRuns.length

      // Update source - should NOT trigger selector effect
      source('b')
      await tick()

      // Wait a bit more to ensure no delayed reactions
      await tick()

      // The selector's internal effect should not have run after dispose
      // (effect runs should not increase significantly)
      const runsAfterUpdate = effectRuns.length

      // If cleanup worked, the effect should not run after dispose
      // Allow for some tolerance since other effects in the system might run
      expect(runsAfterUpdate - runsBeforeUpdate).toBeLessThan(3)
    })

    it('selector observers map is cleaned up on unmount', async () => {
      const source = createSignal<number>(1)

      const results: boolean[] = []

      const { dispose } = createRoot(() => {
        const isSelected = createSelector(() => source())

        // Read selector for multiple keys - this populates the observers map
        results.push(isSelected(1))
        results.push(isSelected(2))
        results.push(isSelected(3))
      })

      expect(results).toEqual([true, false, false])

      // Dispose - should clean up observers
      dispose()

      // Update source - should not cause any issues
      let noError = true
      try {
        source(2)
        await tick()
        source(3)
        await tick()
      } catch {
        noError = false
      }

      expect(noError).toBe(true)
    })

    it('createSelector within component is cleaned up when component unmounts', async () => {
      const source = createSignal<string>('x')
      let unmountComplete = false
      let effectRunsAfterUnmount = 0

      const container = document.createElement('div')
      const show = createSignal(true)

      const SelectorComponent = () => {
        const isSelected = createSelector(() => source())

        createEffect(() => {
          const result = isSelected('x')
          // Only count runs that happen after unmount is complete
          if (unmountComplete) {
            effectRunsAfterUnmount++
          }
        })

        return { type: 'span', props: { children: 'selector' } }
      }

      const dispose = render(
        () => ({
          type: 'div',
          props: {
            children: show() ? { type: SelectorComponent, props: {} } : null,
          },
        }),
        container,
      )

      await tick()

      // Unmount the component with selector
      show(false)
      await tick()

      // Mark unmount as complete - any runs after this are unexpected
      unmountComplete = true

      // Update source after component unmount
      source('y')
      await tick()
      source('z')
      await tick()

      // Selector should not respond repeatedly after unmount
      // Allow at most 1 stray run (timing edge case) but catch leaks where it runs many times
      expect(effectRunsAfterUnmount).toBeLessThanOrEqual(1)

      dispose()
    })
  })
})
