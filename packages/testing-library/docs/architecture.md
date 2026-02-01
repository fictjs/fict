# @fictjs/testing-library Architecture

This document describes the internal architecture and design decisions of `@fictjs/testing-library`.

## Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                   @fictjs/testing-library                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────────┐     ┌──────────────────────────────────┐ │
│  │  render()        │────▶│  @fictjs/runtime                 │ │
│  │  renderHook()    │     │  - fictRender                    │ │
│  │  testEffect()    │     │  - createRoot                    │ │
│  └──────────────────┘     │  - ErrorBoundary/Suspense        │ │
│           │               └──────────────────────────────────┘ │
│           ▼                                                     │
│  ┌──────────────────┐     ┌──────────────────────────────────┐ │
│  │  Container       │────▶│  @testing-library/dom            │ │
│  │  Tracking        │     │  - getQueriesForElement          │ │
│  │  & Cleanup       │     │  - queries (getByText, etc.)     │ │
│  └──────────────────┘     │  - prettyDOM                     │ │
│                           └──────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

## Core Components

### 1. Container Tracking

The library tracks all mounted containers and their associated reactive roots for cleanup:

```typescript
// Set of all mounted containers
const mountedContainers = new Set<MountedRef>()

// Set of all renderHook dispose functions
const mountedHookRoots = new Set<() => void>()

interface MountedRef {
  container?: HTMLElement // The DOM container
  baseElement?: HTMLElement // Base element for queries
  ownedContainer?: boolean // Whether we created the container
  teardown: () => void // Dispose function from fictRender
}
```

**Why this design?**

- Allows `cleanup()` to dispose all reactive roots efficiently
- Tracks ownership to avoid removing user-provided containers
- Separates component renders from hook renders for different cleanup logic

### 2. Auto-Cleanup Mechanism

Auto-cleanup integrates with test framework lifecycle hooks:

```typescript
if (!process.env?.FICT_TL_SKIP_AUTO_CLEANUP) {
  const globalAfterEach = globalThis.afterEach
  if (typeof globalAfterEach === 'function') {
    globalAfterEach(() => {
      cleanup()
    })
  }
}
```

**How it works:**

1. On module load, checks for global `afterEach` (Vitest/Jest)
2. If found, registers cleanup as afterEach hook
3. Cleanup iterates through `mountedContainers` and `mountedHookRoots`
4. Calls teardown functions and removes owned containers from DOM

### 3. Render Function Flow

```
render(view, options)
        │
        ▼
┌───────────────────────┐
│ Determine container   │
│ - Use provided or     │
│ - Create new div      │
└───────────────────────┘
        │
        ▼
┌───────────────────────┐
│ Apply wrapper if any  │
│ - Wrap view in        │
│   wrapper component   │
└───────────────────────┘
        │
        ▼
┌───────────────────────┐
│ Call fictRender()     │
│ - Creates reactive    │
│   root                │
│ - Returns teardown fn │
└───────────────────────┘
        │
        ▼
┌───────────────────────┐
│ Track in              │
│ mountedContainers     │
└───────────────────────┘
        │
        ▼
┌───────────────────────┐
│ Create query helpers  │
│ - getQueriesForElement│
│   from @testing-lib   │
└───────────────────────┘
        │
        ▼
┌───────────────────────┐
│ Return RenderResult   │
│ - container           │
│ - queries             │
│ - debug, unmount, etc │
└───────────────────────┘
```

### 4. RenderHook Architecture

`renderHook()` has a different architecture than `render()` because it doesn't render DOM elements:

```typescript
function renderHook(hookFn, options) {
  const resultContainer = { current: undefined }
  let disposeRoot = null

  const executeHook = () => {
    const { dispose, value } = createRoot(() => {
      // Push context for compiled hooks
      __fictPushContext()
      try {
        // Execute hook with wrapper if provided
        return hookFn(...currentProps)
      } finally {
        __fictPopContext()
      }
    })

    disposeRoot = dispose
    resultContainer.current = value
  }

  executeHook()

  return {
    result: resultContainer,
    rerender: newProps => {
      disposeRoot?.() // Dispose previous root
      currentProps = newProps ?? currentProps
      executeHook() // Create new root
    },
    cleanup: () => disposeRoot?.(),
  }
}
```

**Key design decisions:**

- Uses `createRoot()` directly instead of `fictRender()`
- Result is stored in a container object for mutation
- Context is pushed/popped for compiled hooks to work
- Rerender disposes and recreates the root (state resets)

### 5. TestEffect Implementation

`testEffect()` provides async testing for effects:

```typescript
function testEffect<T>(fn: TestEffectCallback<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const disposeRef = { current: null }

    const root = createRoot(() => {
      // Register error handler for effect errors
      registerErrorHandler(err => {
        reject(err)
        return true
      })

      // Execute test function with done callback
      fn(result => {
        resolve(result)
        queueMicrotask(() => disposeRef.current?.())
      })
    })

    disposeRef.current = root.dispose
  })
}
```

**Design considerations:**

- Creates isolated reactive root for the test
- Registers error handler to catch effect errors
- `done()` callback signals test completion
- Root is disposed after microtask to allow cleanup effects

### 6. Error Boundary & Suspense Testing

These utilities wrap components in boundary components:

```
renderWithErrorBoundary(view, options)
                │
                ▼
┌─────────────────────────────────────┐
│ Create wrapper view:                │
│                                     │
│   () => createElement({             │
│     type: ErrorBoundary,            │
│     props: {                        │
│       fallback: wrappedFallback,    │
│       onError: handler,             │
│       children: view()              │
│     }                               │
│   })                                │
└─────────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────┐
│ Call render() with wrapped view     │
└─────────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────┐
│ Return extended result with:        │
│ - triggerError()                    │
│ - resetErrorBoundary()              │
│ - isShowingFallback()               │
└─────────────────────────────────────┘
```

## Integration Points

### @fictjs/runtime Integration

The library imports from multiple runtime entry points:

```typescript
// Public API
import { render as fictRender, createRoot, ... } from '@fictjs/runtime'

// Advanced API (for signals)
import { registerErrorHandler } from '@fictjs/runtime/advanced'

// Internal API (for hook context)
import { __fictPushContext, __fictPopContext } from '@fictjs/runtime/internal'
```

### @testing-library/dom Integration

Query utilities are obtained per-container:

```typescript
import { getQueriesForElement, prettyDOM, queries } from '@testing-library/dom'

// Bind queries to specific container
const queryHelpers = getQueriesForElement(container, customQueries)
```

The library also re-exports everything from `@testing-library/dom`:

```typescript
export * from '@testing-library/dom'
export { queries, prettyDOM }
```

## Memory Management

### Container Lifecycle

1. **Created on render** - Container added to `mountedContainers`
2. **Tracked until cleanup** - Reference held in Set
3. **Disposed on cleanup** - Teardown called, container removed

### Hook Root Lifecycle

1. **Created on renderHook** - Dispose function added to `mountedHookRoots`
2. **Replaced on rerender** - Old dispose removed, new one added
3. **Disposed on cleanup** - All dispose functions called

### Automatic Cleanup

```
afterEach() hook
       │
       ▼
┌──────────────────────────────┐
│ For each mountedContainer:   │
│ 1. Call teardown()           │
│ 2. Remove container if owned │
│ 3. Delete from Set           │
└──────────────────────────────┘
       │
       ▼
┌──────────────────────────────┐
│ For each hookRoot dispose:   │
│ 1. Call dispose()            │
│ 2. Delete from Set           │
└──────────────────────────────┘
```

## Design Principles

1. **Familiar API** - Mirror `@testing-library/react` patterns where possible
2. **Reactive-aware** - Properly manage Fict reactive roots
3. **Type-safe** - Full TypeScript support with generics
4. **Zero-config** - Works out of the box with Vitest/Jest
5. **Composable** - Individual utilities can be used independently
