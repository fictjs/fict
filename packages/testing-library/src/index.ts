/**
 * @fileoverview @fictjs/testing-library - Testing utilities for Fict components
 *
 * This library provides utilities for testing Fict components in a manner
 * similar to @testing-library/react and @solidjs/testing-library.
 *
 * ## Key Features
 *
 * - `render()` - Render a Fict component and get queries
 * - `cleanup()` - Clean up rendered components
 * - `renderHook()` - Test custom reactive code in isolation
 * - `testEffect()` - Test effects with async assertions
 *
 * ## Example Usage
 *
 * ```tsx
 * import { render, screen, cleanup } from '@fictjs/testing-library'
 *
 * test('renders greeting', () => {
 *   render(() => <Greeting name="World" />)
 *   expect(screen.getByText('Hello, World!')).toBeInTheDocument()
 * })
 * ```
 *
 * @packageDocumentation
 */

import { render as fictRender, createRoot, createElement } from '@fictjs/runtime'
import type { FictNode, Component } from '@fictjs/runtime'
import { getQueriesForElement, prettyDOM, queries } from '@testing-library/dom'
import type { Queries } from '@testing-library/dom'

import type {
  MountedRef,
  View,
  RenderOptions,
  RenderResult,
  DebugFn,
  RenderHookOptions,
  RenderHookResult,
  TestEffectCallback,
} from './types'

// ============================================================================
// Container Tracking
// ============================================================================

/**
 * Set of all mounted containers for cleanup tracking.
 */
const mountedContainers = new Set<MountedRef>()
const mountedHookRoots = new Set<() => void>()

// ============================================================================
// Auto-Cleanup Setup
// ============================================================================

// Register automatic cleanup with test framework's afterEach hook
// Can be disabled via FICT_TL_SKIP_AUTO_CLEANUP environment variable
if (typeof process === 'undefined' || !process.env?.FICT_TL_SKIP_AUTO_CLEANUP) {
  // Vitest/Jest provide afterEach globally
  // Use type assertion to avoid TS errors in non-test environments
  const globalAfterEach = (globalThis as { afterEach?: (fn: () => void) => void }).afterEach
  if (typeof globalAfterEach === 'function') {
    globalAfterEach(() => {
      cleanup()
    })
  }
}

// ============================================================================
// Render Function
// ============================================================================

/**
 * Render a Fict component for testing.
 *
 * @param view - A function that returns the component to render
 * @param options - Render options (container, baseElement, queries, wrapper)
 * @returns A render result with queries and utilities
 *
 * @example
 * ```tsx
 * // Basic usage
 * const { getByText } = render(() => <MyComponent />)
 * expect(getByText('Hello')).toBeInTheDocument()
 *
 * // With wrapper (for context providers)
 * const { getByText } = render(() => <MyComponent />, {
 *   wrapper: ({ children }) => <ThemeProvider>{children}</ThemeProvider>
 * })
 *
 * // With custom container
 * const container = document.createElement('div')
 * const { getByText } = render(() => <MyComponent />, { container })
 * ```
 */
export function render<Q extends Queries = typeof queries>(
  view: View,
  options: RenderOptions<Q> = {},
): RenderResult<Q> {
  const {
    container: providedContainer,
    baseElement: providedBaseElement,
    queries: customQueries,
    wrapper,
  } = options

  // Determine container and baseElement
  let container = providedContainer
  let baseElement = providedBaseElement
  let ownedContainer = false

  if (!baseElement) {
    baseElement = container ?? document.body
  }

  if (!container) {
    container = baseElement.appendChild(document.createElement('div'))
    ownedContainer = true
  }

  // Wrap view with wrapper component if provided
  let wrappedView: View = view
  if (wrapper) {
    const Wrapper = wrapper as unknown as (props: Record<string, unknown>) => FictNode
    wrappedView = () => {
      const children = view()
      return createElement({ type: Wrapper, props: { children } }) as FictNode
    }
  }

  // Track teardown function for cleanup
  let currentTeardown: (() => void) | null = null

  // Render the view
  const teardown = fictRender(wrappedView, container)
  currentTeardown = teardown

  // Track this container for cleanup
  const ref: MountedRef = { container, baseElement, ownedContainer, teardown }
  mountedContainers.add(ref)

  // Get query utilities bound to this container
  const queryHelpers = getQueriesForElement<Q>(container, customQueries as Q)

  // Debug function
  const debug: DebugFn = (el = baseElement, maxLength, debugOptions) => {
    if (Array.isArray(el)) {
      el.forEach(e => console.log(prettyDOM(e, maxLength, debugOptions)))
    } else {
      console.log(prettyDOM(el, maxLength, debugOptions))
    }
  }

  // Unmount function
  const unmount = () => {
    if (currentTeardown) {
      currentTeardown()
      currentTeardown = null
    }
    if (ownedContainer && container?.parentNode) {
      container.parentNode.removeChild(container)
    }
    mountedContainers.delete(ref)
  }

  // Rerender function
  const rerender = (newView: View) => {
    // Clean up existing render
    if (currentTeardown) {
      currentTeardown()
    }

    // Re-wrap if wrapper exists
    let wrappedNewView: View = newView
    if (wrapper) {
      const Wrapper = wrapper as unknown as (props: Record<string, unknown>) => FictNode
      wrappedNewView = () => {
        const children = newView()
        return createElement({ type: Wrapper, props: { children } }) as FictNode
      }
    }

    // Re-render
    currentTeardown = fictRender(wrappedNewView, container!)
    ref.teardown = currentTeardown
  }

  return {
    asFragment: () => container?.innerHTML ?? '',
    container: container!,
    baseElement: baseElement!,
    debug,
    unmount,
    rerender,
    ...queryHelpers,
  } as RenderResult<Q>
}

// ============================================================================
// Cleanup Function
// ============================================================================

/**
 * Clean up a specific mounted container.
 */
function cleanupAtContainer(ref: MountedRef): void {
  const { container, teardown, ownedContainer } = ref

  // Call the teardown function
  if (typeof teardown === 'function') {
    teardown()
  } else if (typeof teardown !== 'undefined') {
    // Warn if teardown is not a function (could indicate version mismatch)
    console.warn(
      '[@fictjs/testing-library] Expected teardown to be a function. ' +
        'This might indicate a version mismatch between @fictjs/runtime and @fictjs/testing-library.',
    )
  }

  // Remove container from DOM if it was created by render()
  if (ownedContainer && container?.parentNode) {
    container.parentNode.removeChild(container)
  }

  // Remove from tracking
  mountedContainers.delete(ref)
}

/**
 * Clean up all rendered components.
 *
 * This is called automatically after each test when using Vitest/Jest.
 * Can be called manually if needed.
 *
 * @example
 * ```ts
 * afterEach(() => {
 *   cleanup()
 * })
 * ```
 */
export function cleanup(): void {
  mountedContainers.forEach(cleanupAtContainer)
  mountedHookRoots.forEach(dispose => {
    try {
      dispose()
    } catch (err) {
      console.error('[fict/testing-library] Error during hook cleanup:', err)
    }
  })
  mountedHookRoots.clear()
}

// ============================================================================
// RenderHook Function
// ============================================================================

/**
 * Render a hook/reactive code for testing.
 *
 * This is useful for testing custom reactive logic that uses
 * createEffect, createMemo, onMount, etc.
 *
 * @param hookFn - A function that contains the reactive code to test
 * @param options - Options for rendering the hook
 * @returns Result with the hook's return value and cleanup utilities
 *
 * @example
 * ```ts
 * // Test a counter hook
 * function useCounter(initial: number) {
 *   let count = $state(initial)
 *   const increment = () => count++
 *   return { count: () => count, increment }
 * }
 *
 * test('counter increments', () => {
 *   const { result, cleanup } = renderHook(() => useCounter(0))
 *   expect(result.current.count()).toBe(0)
 *   result.current.increment()
 *   expect(result.current.count()).toBe(1)
 *   cleanup()
 * })
 *
 * // With initial props
 * const { result, rerender } = renderHook(
 *   (initial) => useCounter(initial),
 *   { initialProps: [10] }
 * )
 * expect(result.current.count()).toBe(10)
 * rerender([20]) // Re-run with new props
 * ```
 */
export function renderHook<Result, Props extends unknown[] = []>(
  hookFn: (...args: Props) => Result,
  options: RenderHookOptions<Props> | Props = {},
): RenderHookResult<Result, Props> {
  // Handle shorthand array syntax for initial props
  let initialProps: Props | undefined
  let wrapper: Component<{ children: FictNode }> | undefined

  if (Array.isArray(options)) {
    initialProps = options
  } else {
    initialProps = options.initialProps
    wrapper = options.wrapper
  }

  // Use a mutable result container so updates are visible to the caller
  const resultContainer: { current: Result } = { current: undefined as Result }
  let currentProps = initialProps ?? ([] as unknown as Props)
  let disposeRoot: (() => void) | null = null
  let registeredDispose: (() => void) | null = null

  const registerDispose = (dispose: () => void) => {
    if (registeredDispose) {
      mountedHookRoots.delete(registeredDispose)
    }
    registeredDispose = dispose
    mountedHookRoots.add(dispose)
  }

  // Function to execute the hook
  const executeHook = () => {
    const { dispose, value } = createRoot(() => {
      let hookResult: Result
      // If there's a wrapper, we need to create the wrapper element
      if (wrapper) {
        const Wrapper = wrapper as unknown as (props: Record<string, unknown>) => FictNode
        // Create a dummy element that executes the hook
        createElement({
          type: Wrapper,
          props: {
            children: (() => {
              hookResult = hookFn(...currentProps)
              return null
            })(),
          },
        })
      } else {
        hookResult = hookFn(...currentProps)
      }
      return hookResult!
    })

    disposeRoot = dispose
    registerDispose(dispose)
    resultContainer.current = value
    return value
  }

  executeHook()

  // Rerender with new props
  const rerender = (newProps?: Props) => {
    // Dispose of previous root
    if (disposeRoot) {
      disposeRoot()
    }

    // Update props
    if (newProps !== undefined) {
      currentProps = newProps
    }

    // Re-execute
    executeHook()
  }

  // Cleanup function
  const cleanupHook = () => {
    if (disposeRoot) {
      disposeRoot()
      disposeRoot = null
    }
    if (registeredDispose) {
      mountedHookRoots.delete(registeredDispose)
      registeredDispose = null
    }
  }

  return {
    result: resultContainer,
    rerender,
    cleanup: cleanupHook,
    unmount: cleanupHook,
  }
}

// ============================================================================
// TestEffect Function
// ============================================================================

/**
 * Test an effect asynchronously.
 *
 * This is useful for testing effects that need to wait for async operations
 * or reactive updates.
 *
 * @param fn - A function that receives a `done` callback to signal completion
 * @param owner - Optional root context to run the effect in
 * @returns A promise that resolves with the result passed to `done`
 *
 * @example
 * ```ts
 * // Test an async effect
 * test('fetches data', async () => {
 *   const result = await testEffect((done) => {
 *     let data = $state(null)
 *
 *     createEffect(() => {
 *       if (data !== null) {
 *         done(data)
 *       }
 *     })
 *
 *     // Simulate async data fetch
 *     setTimeout(() => {
 *       data = 'Hello'
 *     }, 100)
 *   })
 *
 *   expect(result).toBe('Hello')
 * })
 *
 * // Test reactive updates
 * test('derived value updates', async () => {
 *   const result = await testEffect<number>((done) => {
 *     let count = $state(0)
 *     const doubled = count * 2
 *
 *     createEffect(() => {
 *       if (doubled === 4) {
 *         done(doubled)
 *       }
 *     })
 *
 *     count = 2
 *   })
 *
 *   expect(result).toBe(4)
 * })
 * ```
 */
export function testEffect<T = void>(fn: TestEffectCallback<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const { dispose } = createRoot(() => {
      try {
        fn(result => {
          resolve(result)
          // Dispose the root after the done callback is called
          // Use queueMicrotask to ensure any pending reactive updates complete
          queueMicrotask(() => {
            dispose()
          })
        })
      } catch (err) {
        reject(err)
        dispose()
      }
    })
  })
}

// ============================================================================
// Additional Utilities
// ============================================================================

/**
 * Wait for a condition to be true.
 * This is a simple wrapper that can be used alongside testEffect.
 *
 * @param condition - A function that returns true when the condition is met
 * @param options - Options for waiting (timeout, interval)
 * @returns A promise that resolves when the condition is true
 *
 * @example
 * ```ts
 * await waitForCondition(() => element.textContent === 'Loaded')
 * ```
 */
export function waitForCondition(
  condition: () => boolean,
  options: { timeout?: number; interval?: number } = {},
): Promise<void> {
  const { timeout = 1000, interval = 50 } = options

  return new Promise((resolve, reject) => {
    const startTime = Date.now()

    const check = () => {
      if (condition()) {
        resolve()
        return
      }

      if (Date.now() - startTime >= timeout) {
        reject(new Error(`waitForCondition timed out after ${timeout}ms`))
        return
      }

      setTimeout(check, interval)
    }

    check()
  })
}

/**
 * Flush pending microtasks and effects.
 * Useful for ensuring all reactive updates have completed.
 *
 * @returns A promise that resolves after microtasks are flushed
 */
export function flush(): Promise<void> {
  return new Promise(resolve => queueMicrotask(resolve))
}

// ============================================================================
// Re-exports from @testing-library/dom
// ============================================================================

// Export everything from @testing-library/dom
export * from '@testing-library/dom'

// Named re-exports for convenience
export { queries, prettyDOM }

// ============================================================================
// Type Re-exports
// ============================================================================

export type {
  View,
  RenderOptions,
  RenderResult,
  RenderHookOptions,
  RenderHookResult,
  TestEffectCallback,
  DebugFn,
  MountedRef,
} from './types'
