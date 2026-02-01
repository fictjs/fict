# @fictjs/testing-library

Testing utilities for Fict components, built on top of `@testing-library/dom`.

## Table of Contents

- [Overview](#overview)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Core Concepts](#core-concepts)
- [API Reference](#api-reference)
- [Type Definitions](#type-definitions)
- [Testing Patterns](#testing-patterns)
- [Troubleshooting](#troubleshooting)

## Overview

`@fictjs/testing-library` provides a set of utilities for testing Fict components in a manner similar to `@testing-library/react` and `@solidjs/testing-library`. It integrates seamlessly with Fict's reactive runtime while leveraging the familiar query APIs from `@testing-library/dom`.

### Key Features

| Feature                | Description                                          |
| ---------------------- | ---------------------------------------------------- |
| `render()`             | Render Fict components and get query utilities       |
| `cleanup()`            | Automatic cleanup of rendered components             |
| `renderHook()`         | Test custom reactive hooks in isolation              |
| `testEffect()`         | Test effects with async assertions                   |
| `act()`                | Flush pending microtasks and effects                 |
| Error Boundary Testing | Test error handling with `renderWithErrorBoundary()` |
| Suspense Testing       | Test loading states with `renderWithSuspense()`      |

## Installation

```bash
pnpm add -D @fictjs/testing-library
# or
npm install --save-dev @fictjs/testing-library
# or
yarn add -D @fictjs/testing-library
```

**Peer Dependencies:**

```bash
pnpm add @fictjs/runtime @testing-library/dom
```

## Quick Start

### Basic Component Testing

```tsx
import { render, screen, cleanup } from '@fictjs/testing-library'
import { describe, it, expect, afterEach } from 'vitest'

// Cleanup is automatic with Vitest/Jest
describe('Greeting', () => {
  it('renders greeting message', () => {
    const { getByText } = render(() => <Greeting name="World" />)

    expect(getByText('Hello, World!')).toBeInTheDocument()
  })
})
```

### Testing with User Interactions

```tsx
import { render, fireEvent } from '@fictjs/testing-library'

it('increments counter on click', async () => {
  const { getByRole, getByText } = render(() => <Counter />)

  const button = getByRole('button')
  fireEvent.click(button)

  expect(getByText('Count: 1')).toBeInTheDocument()
})
```

### Testing Reactive Hooks

```tsx
import { renderHook } from '@fictjs/testing-library'

function useCounter(initial: number) {
  let count = $state(initial)
  const increment = () => count++
  return { count: () => count, increment }
}

it('increments counter', () => {
  const { result } = renderHook(() => useCounter(0))

  expect(result.current.count()).toBe(0)
  result.current.increment()
  expect(result.current.count()).toBe(1)
})
```

## Core Concepts

### 1. Component Rendering

The `render()` function renders a Fict component into a container and returns query utilities bound to that container:

```tsx
const { container, getByText, queryByRole } = render(() => <MyComponent />)
```

The component is rendered inside a reactive root, enabling full reactivity during tests.

### 2. Automatic Cleanup

By default, cleanup runs automatically after each test when using Vitest or Jest. This can be disabled via the `FICT_TL_SKIP_AUTO_CLEANUP` environment variable.

```tsx
// Cleanup runs automatically - no manual cleanup needed!
it('first test', () => {
  render(() => <ComponentA />)
})

it('second test', () => {
  render(() => <ComponentB />) // Previous render is already cleaned up
})
```

### 3. Testing Reactive Code

Use `renderHook()` to test reactive hooks and custom logic:

```tsx
const { result, rerender, cleanup } = renderHook(initial => useMyHook(initial), {
  initialProps: [10],
})

// Access hook return values
result.current.someMethod()

// Rerender with new props (note: state resets on rerender)
rerender([20])
```

> **Note:** `rerender()` disposes the previous root and creates a new one. Hook state does not persist across rerenders.

### 4. Testing Effects

Use `testEffect()` for testing async effects:

```tsx
const result = await testEffect<string>(done => {
  const data = $state<string | null>(null)

  $effect(() => {
    if (data !== null) {
      done(data) // Signal completion
    }
  })

  // Simulate async operation
  setTimeout(() => {
    data = 'loaded'
  }, 100)
})

expect(result).toBe('loaded')
```

### 5. Flushing Updates

Use `act()` to ensure all pending microtasks and effects are flushed:

```tsx
await act(() => {
  result.current.increment()
})

// All effects have run, assertions are safe
expect(result.current.count()).toBe(1)
```

## API Reference

### render

Render a Fict component for testing.

```typescript
function render<Q extends Queries = typeof queries>(
  view: View,
  options?: RenderOptions<Q>,
): RenderResult<Q>
```

**Parameters:**

| Name                  | Type             | Description                                                       |
| --------------------- | ---------------- | ----------------------------------------------------------------- |
| `view`                | `() => FictNode` | A function that returns the component to render                   |
| `options.container`   | `HTMLElement?`   | Container element to render into                                  |
| `options.baseElement` | `HTMLElement?`   | Base element for queries (defaults to container or document.body) |
| `options.queries`     | `Queries?`       | Custom queries to use                                             |
| `options.wrapper`     | `Component?`     | Wrapper component (e.g., for context providers)                   |

**Returns:**

| Property                        | Type                   | Description                             |
| ------------------------------- | ---------------------- | --------------------------------------- |
| `container`                     | `HTMLElement`          | The container element                   |
| `baseElement`                   | `HTMLElement`          | The base element for queries            |
| `asFragment()`                  | `() => string`         | Returns the container's innerHTML       |
| `debug()`                       | `DebugFn`              | Pretty-print the DOM to console         |
| `unmount()`                     | `() => void`           | Unmount and cleanup                     |
| `rerender(view)`                | `(view: View) => void` | Re-render with a new view               |
| `getByText`, `queryByRole`, ... | Query functions        | All queries from `@testing-library/dom` |

**Example:**

```tsx
// Basic usage
const { getByText } = render(() => <MyComponent />)
expect(getByText('Hello')).toBeInTheDocument()

// With wrapper for context
const { getByText } = render(() => <MyComponent />, {
  wrapper: ({ children }) => <ThemeProvider>{children}</ThemeProvider>,
})

// With custom container
const container = document.createElement('div')
render(() => <MyComponent />, { container })
```

---

### cleanup

Clean up all rendered components.

```typescript
function cleanup(): void
```

Called automatically after each test. Can be called manually if needed.

---

### renderHook

Render a hook/reactive code for testing.

```typescript
function renderHook<Result, Props extends unknown[] = []>(
  hookFn: (...args: Props) => Result,
  options?: RenderHookOptions<Props> | Props,
): RenderHookResult<Result, Props>
```

**Parameters:**

| Name                   | Type                         | Description                       |
| ---------------------- | ---------------------------- | --------------------------------- |
| `hookFn`               | `(...args: Props) => Result` | The hook function to test         |
| `options.initialProps` | `Props?`                     | Initial props to pass to the hook |
| `options.wrapper`      | `Component?`                 | Wrapper component                 |

**Returns:**

| Property           | Type                      | Description                               |
| ------------------ | ------------------------- | ----------------------------------------- |
| `result`           | `{ current: Result }`     | Container holding the hook's return value |
| `rerender(props?)` | `(props?: Props) => void` | Rerender with new props                   |
| `cleanup()`        | `() => void`              | Clean up the hook                         |
| `unmount()`        | `() => void`              | Alias for cleanup                         |

**Example:**

```tsx
// Test a counter hook
const { result } = renderHook((initial: number) => useCounter(initial), {
  initialProps: [10],
})

expect(result.current.count()).toBe(10)
result.current.increment()
expect(result.current.count()).toBe(11)

// Shorthand array syntax for initial props
const { result } = renderHook((a, b) => useMyHook(a, b), ['foo', 42])
```

---

### testEffect

Test an effect asynchronously.

```typescript
function testEffect<T = void>(fn: TestEffectCallback<T>): Promise<T>

type TestEffectCallback<T> = (done: (result: T) => void) => void
```

**Example:**

```tsx
// Test async data loading
const result = await testEffect<number>(done => {
  const count = $state(0)

  $effect(() => {
    if (count === 3) {
      done(count)
    }
  })

  count = 1
  count = 2
  count = 3 // Triggers done()
})

expect(result).toBe(3)
```

---

### act

Run updates and flush pending microtasks/effects.

```typescript
async function act<T>(fn: () => T | Promise<T>): Promise<T>
```

**Example:**

```tsx
await act(() => {
  result.current.increment()
})
// All effects have been flushed
```

---

### flush

Flush pending microtasks.

```typescript
function flush(): Promise<void>
```

---

### waitForCondition

Wait for a condition to be true.

```typescript
function waitForCondition(
  condition: () => boolean,
  options?: { timeout?: number; interval?: number },
): Promise<void>
```

**Example:**

```tsx
await waitForCondition(() => element.textContent === 'Loaded', {
  timeout: 1000,
  interval: 50,
})
```

---

### renderWithErrorBoundary

Render a view wrapped in an ErrorBoundary.

```typescript
function renderWithErrorBoundary<Q extends Queries>(
  view: View,
  options?: ErrorBoundaryRenderOptions<Q>,
): ErrorBoundaryRenderResult<Q>
```

**Additional Options:**

| Name        | Type                                     | Description                   |
| ----------- | ---------------------------------------- | ----------------------------- |
| `fallback`  | `FictNode \| ((err, reset) => FictNode)` | Fallback UI when error occurs |
| `onError`   | `(err: unknown) => void`                 | Callback when error is caught |
| `resetKeys` | `unknown \| (() => unknown)`             | Keys that trigger a reset     |

**Additional Returns:**

| Property               | Type                     | Description                |
| ---------------------- | ------------------------ | -------------------------- |
| `triggerError(error)`  | `(error: Error) => void` | Trigger an error           |
| `resetErrorBoundary()` | `() => void`             | Reset the error boundary   |
| `isShowingFallback()`  | `() => boolean`          | Check if fallback is shown |

**Example:**

```tsx
const onError = vi.fn()
const { isShowingFallback, triggerError } = renderWithErrorBoundary(
  () => <ComponentThatMightThrow />,
  {
    fallback: err => <div data-testid="error">{err.message}</div>,
    onError,
  },
)

triggerError(new Error('Test error'))
expect(isShowingFallback()).toBe(true)
expect(onError).toHaveBeenCalled()
```

---

### renderWithSuspense

Render a view wrapped in a Suspense boundary.

```typescript
function renderWithSuspense<Q extends Queries>(
  view: View,
  options?: SuspenseRenderOptions<Q>,
): SuspenseRenderResult<Q>
```

**Additional Options:**

| Name        | Type                           | Description                     |
| ----------- | ------------------------------ | ------------------------------- |
| `fallback`  | `FictNode \| (() => FictNode)` | Loading UI while suspended      |
| `onResolve` | `() => void`                   | Callback when suspense resolves |
| `onReject`  | `(err: unknown) => void`       | Callback when suspense rejects  |

**Additional Returns:**

| Property                      | Type                                      | Description                        |
| ----------------------------- | ----------------------------------------- | ---------------------------------- |
| `isShowingFallback()`         | `() => boolean`                           | Check if loading fallback is shown |
| `waitForResolution(options?)` | `(options?: {timeout?}) => Promise<void>` | Wait for suspense to resolve       |

**Example:**

```tsx
const { token, resolve } = createTestSuspenseToken()

const { isShowingFallback, waitForResolution } = renderWithSuspense(
  () => <AsyncComponent token={token} />,
  { fallback: <div>Loading...</div> },
)

expect(isShowingFallback()).toBe(true)

resolve()
await waitForResolution()

expect(isShowingFallback()).toBe(false)
```

---

### createTestSuspenseToken

Create a test suspense token for controlling suspense in tests.

```typescript
function createTestSuspenseToken(): TestSuspenseHandle

interface TestSuspenseHandle {
  token: { then: PromiseLike<void>['then'] }
  resolve: () => void
  reject: (err: unknown) => void
}
```

**Example:**

```tsx
const { token, resolve, reject } = createTestSuspenseToken()

// Throw token in component to trigger suspense
const Component = () => {
  throw token
}

// Later, resolve to continue rendering
resolve()
```

## Type Definitions

### Core Types

```typescript
/** A Fict view function */
type View = () => FictNode

/** Render options */
interface RenderOptions<Q extends Queries> {
  container?: HTMLElement
  baseElement?: HTMLElement
  queries?: Q
  wrapper?: Component<{ children: FictNode }>
}

/** RenderHook options */
interface RenderHookOptions<Props extends unknown[]> {
  initialProps?: Props
  wrapper?: Component<{ children: FictNode }>
}

/** TestEffect callback */
type TestEffectCallback<T> = (done: (result: T) => void) => void
```

### Result Types

```typescript
/** Render result */
type RenderResult<Q extends Queries> = BoundFunctions<Q> & {
  asFragment: () => string
  container: HTMLElement
  baseElement: HTMLElement
  debug: DebugFn
  unmount: () => void
  rerender: (newView: View) => void
}

/** RenderHook result */
interface RenderHookResult<Result, Props extends unknown[]> {
  result: { current: Result }
  rerender: (newProps?: Props) => void
  cleanup: () => void
  unmount: () => void
}
```

## Testing Patterns

### Testing with Context Providers

```tsx
const AllProviders = ({ children }: { children: FictNode }) => (
  <ThemeProvider>
    <AuthProvider>{children}</AuthProvider>
  </ThemeProvider>
)

const { getByText } = render(() => <MyComponent />, {
  wrapper: AllProviders,
})
```

### Testing Reactive State Changes

```tsx
import { renderHook, act } from '@fictjs/testing-library'

it('handles state updates', async () => {
  const { result } = renderHook(() => {
    const count = createSignal(0)
    return { count, inc: () => count(count() + 1) }
  })

  await act(() => {
    result.current.inc()
  })

  expect(result.current.count()).toBe(1)
})
```

### Testing Async Effects

```tsx
import { testEffect } from '@fictjs/testing-library'

it('loads data asynchronously', async () => {
  const result = await testEffect<Data>(done => {
    const data = $state<Data | null>(null)

    $effect(() => {
      if (data) done(data)
    })

    fetchData().then(d => {
      data = d
    })
  })

  expect(result).toEqual(expectedData)
})
```

### Testing Error Boundaries

```tsx
it('shows error fallback when child throws', () => {
  const { isShowingFallback, triggerError, getByTestId } = renderWithErrorBoundary(
    () => <ChildComponent />,
    {
      fallback: err => <div data-testid="error">{String(err)}</div>,
    },
  )

  triggerError(new Error('Something went wrong'))

  expect(isShowingFallback()).toBe(true)
  expect(getByTestId('error').textContent).toContain('Something went wrong')
})
```

## Troubleshooting

### Common Issues

#### 1. "Cleanup not running between tests"

**Cause:** Auto-cleanup may not be set up correctly.

**Solution:** Ensure you're using Vitest or Jest, or manually call `cleanup()`:

```tsx
import { cleanup } from '@fictjs/testing-library'

afterEach(() => {
  cleanup()
})
```

#### 2. "Hook state resets on rerender"

**Cause:** This is expected behavior. `renderHook().rerender()` disposes the previous root and creates a new one.

**Solution:** If you need persistent state, test it within a single hook execution:

```tsx
const { result } = renderHook(() => useMyHook())
result.current.increment() // State persists here
result.current.increment() // And here
// rerender() creates a fresh hook instance
```

#### 3. "Effects not running in tests"

**Cause:** Effects are scheduled asynchronously.

**Solution:** Use `act()` or `await` with `flush()`:

```tsx
await act(() => {
  result.current.triggerEffect()
})
// Effects have now run
```

#### 4. "Queries not finding elements"

**Cause:** Element may not be in the queried container.

**Solution:** Use `debug()` to inspect the DOM:

```tsx
const { debug, queryByText } = render(() => <MyComponent />)
debug() // Prints the DOM to console
```

### Configuration

#### Disabling Auto-Cleanup

Set the environment variable:

```bash
FICT_TL_SKIP_AUTO_CLEANUP=1 npm test
```

#### Using Custom Queries

```tsx
import { buildQueries } from '@testing-library/dom'

const queryAllByDataCy = (container, value) =>
  container.querySelectorAll(`[data-cy="${value}"]`)

const [
  queryByDataCy,
  getAllByDataCy,
  getByDataCy,
  findAllByDataCy,
  findByDataCy,
] = buildQueries(queryAllByDataCy, ...)

const { getByDataCy } = render(() => <MyComponent />, {
  queries: { getByDataCy, queryByDataCy, ... }
})
```

## Related Packages

- `@fictjs/runtime` - Core reactive runtime
- `@fictjs/compiler` - JSX compiler
- `@fictjs/vite-plugin` - Vite integration
- `@testing-library/dom` - DOM testing utilities

## License

MIT
