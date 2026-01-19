# Fict API Reference

Fict is a compiler-first, fine-grained reactive UI framework. This document covers all developer-facing public APIs.

## Table of Contents

- [Quick Start](#quick-start)
- [Reactivity Core](#reactivity-core)
  - [$state](#state)
  - [$effect](#effect)
  - [$memo](#memo)
  - [$store](#store)
  - [createSignal](#createsignal)
  - [createMemo](#creatememo)
  - [createEffect](#createeffect)
  - [createSelector](#createselector)
- [Lifecycle](#lifecycle)
  - [onMount](#onmount)
  - [onDestroy](#ondestroy)
  - [onCleanup](#oncleanup)
  - [createRoot](#createroot)
- [Scheduling & Control](#scheduling--control)
  - [batch](#batch)
  - [untrack](#untrack)
  - [startTransition](#starttransition)
  - [useTransition](#usetransition)
  - [useDeferredValue](#usedeferredvalue)
- [DOM Rendering](#dom-rendering)
  - [render](#render)
  - [Fragment](#fragment)
- [Components](#components)
  - [ErrorBoundary](#errorboundary)
  - [Suspense](#suspense)
- [Props Utilities](#props-utilities)
  - [mergeProps](#mergeprops)
  - [prop](#prop)
- [Ref](#ref)
  - [createRef](#createref)
- [Context](#context)
  - [createContext](#createcontext)
  - [useContext](#usecontext)
  - [hasContext](#hascontext)
- [Extended API (fict/plus)](#extended-api-fictplus)
  - [resource](#resource)
  - [lazy](#lazy)
- [Advanced APIs (fict/advanced)](#advanced-apis-fictadvanced)
  - [setCycleProtectionOptions](#setcycleprotectionoptions)
- [Type Definitions](#type-definitions)

---

## Quick Start

```tsx
import { $state, $effect, render } from 'fict'

function Counter() {
  let count = $state(0)

  $effect(() => {
    console.log('Count changed:', count)
  })

  return <button onClick={() => count++}>Clicked {count} times</button>
}

render(() => <Counter />, document.getElementById('app')!)
```

---

## Reactivity Core

### $state

Declare a reactive state variable. This is a compiler macro that compiles to the underlying signal mechanism.

```typescript
let value = $state<T>(initialValue: T)
```

**Example:**

```tsx
function Counter() {
  // Primitives
  let count = $state(0)

  // Objects
  let user = $state({ name: 'Alice', age: 25 })

  // Arrays
  let items = $state<string[]>([])

  return (
    <div>
      <p>Count: {count}</p>
      <button onClick={() => count++}>Increment</button>
      <button onClick={() => (user = { ...user, age: user.age + 1 })}>Birthday</button>
      <button onClick={() => (items = [...items, 'new item'])}>Add Item</button>
    </div>
  )
}
```

**Notes:**

- `$state` can only be used at the top level of a component function, not inside conditionals or loops.
- For objects/arrays, create new references for updates (immutable updates).
- For deep reactivity, use `$store`.

---

### $effect

Declare a side effect. It re-runs automatically when reactive dependencies change.

```typescript
$effect(fn: () => void | (() => void))
```

**Example:**

```tsx
function Timer() {
  let seconds = $state(0)

  // Basic effect
  $effect(() => {
    console.log('Seconds:', seconds)
  })

  // Effect with cleanup
  $effect(() => {
    const id = setInterval(() => seconds++, 1000)
    return () => clearInterval(id) // cleanup
  })

  // Depend on external API
  $effect(() => {
    document.title = `Timer: ${seconds}s`
  })

  return <div>Elapsed: {seconds}s</div>
}
```

**Notes:**

- Cleanup runs before the next execution and when the component is destroyed.
- Avoid `async/await` inside `$effect`; for async work, use `resource`.
- Dependencies are tracked automatically; no dependency arrays needed.

---

### $memo

Declare an explicit computed value (usually unnecessary because the compiler can infer).

```typescript
const value = $memo<T>(fn: () => T)
```

**Example:**

```tsx
function TodoList() {
  let todos = $state([
    { id: 1, text: 'Learn Fict', done: false },
    { id: 2, text: 'Build app', done: true },
  ])

  // Inferred computed values (recommended)
  const activeTodos = () => todos.filter(t => !t.done)
  const completedCount = () => todos.filter(t => t.done).length

  // Explicit $memo (when caching must be enforced)
  const expensiveComputation = $memo(() => {
    return todos.reduce((acc, t) => acc + t.text.length, 0)
  })

  return (
    <div>
      <p>Active: {activeTodos().length}</p>
      <p>Completed: {completedCount()}</p>
      <p>Total chars: {expensiveComputation}</p>
    </div>
  )
}
```

---

### $store

Create a deeply reactive proxy that allows direct mutation of nested properties.

```typescript
import { $store } from 'fict'

function $store<T extends object>(initialValue: T): T
```

**Example:**

```tsx
import { $store } from 'fict'

function NestedState() {
  const state = $store({
    user: {
      name: 'Alice',
      settings: {
        theme: 'dark',
        notifications: true,
      },
    },
    items: [1, 2, 3],
  })

  return (
    <div>
      <p>Name: {state.user.name}</p>
      <p>Theme: {state.user.settings.theme}</p>

      {/* Directly mutate nested props */}
      <button onClick={() => (state.user.name = 'Bob')}>Change name</button>
      <button onClick={() => (state.user.settings.theme = 'light')}>Toggle theme</button>
      <button onClick={() => state.items.push(4)}>Add item</button>
    </div>
  )
}
```

**Difference vs `$state`:**

| Feature        | `$state`                      | `$store`               |
| -------------- | ----------------------------- | ---------------------- |
| Reactive depth | Shallow (immutable updates)   | Deep (direct mutation) |
| Syntax         | `let x = $state(v)`           | `const x = $store(v)`  |
| Update style   | `x = newValue`                | `x.prop = newValue`    |
| Best for       | Simple values, immutable data | Complex nested objects |

---

### createSignal

Low-level API: create a reactive signal.

```typescript
function createSignal<T>(initialValue: T): Signal<T>

type Signal<T> = [get: () => T, set: (value: T | ((prev: T) => T)) => void]
```

**Example:**

```tsx
import { createEffect } from 'fict'
import { createSignal } from 'fict/advanced'

function Counter() {
  const [count, setCount] = createSignal(0)

  createEffect(() => {
    console.log('Count is now:', count())
  })

  return <button onClick={() => setCount(c => c + 1)}>Count: {count()}</button>
}
```

### Choosing `$state` vs `createSignal`

| Choose             | When                                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| **`$state`**       | ✅ Local component state (default) <br> ✅ Simple local read/write <br> ✅ Concise syntax (`count++`)                      |
| **`createSignal`** | ✅ Module-level shared state (global store) <br> ✅ Custom hooks that return a signal <br> ✅ Utility / non-component code |

> [!TIP]
> General rule: use `$state` inside components; use `createSignal` or `$store` for shared or non-component scenarios.

---

### createMemo

Low-level API: create a cached computed value.

```typescript
function createMemo<T>(fn: () => T): () => T
```

**Example:**

```tsx
import { createMemo } from 'fict'
import { createSignal } from 'fict/advanced'

function FilteredList() {
  const [items, setItems] = createSignal([1, 2, 3, 4, 5])
  const [threshold, setThreshold] = createSignal(3)

  // Recomputes only when items or threshold change
  const filtered = createMemo(() => items().filter(n => n > threshold()))

  return (
    <div>
      <p>Filtered: {filtered().join(', ')}</p>
      <button onClick={() => setThreshold(t => t - 1)}>Lower threshold</button>
    </div>
  )
}
```

---

### createEffect

Low-level API: create a reactive side effect.

```typescript
function createEffect(fn: () => void | (() => void)): () => void
```

**Example:**

```tsx
import { createEffect } from 'fict'
import { createSignal } from 'fict/advanced'

function Logger() {
  const [message, setMessage] = createSignal('Hello')

  // Returns a disposer
  const dispose = createEffect(() => {
    console.log('Message:', message())

    return () => {
      console.log('Cleaning up previous effect')
    }
  })

  // Manually stop the effect if needed
  // dispose()

  return <input value={message()} onInput={e => setMessage(e.target.value)} />
}
```

---

### createSelector

Create a selector for fine-grained subscription optimization (e.g., list item selection).

```typescript
function createSelector<T, U = T>(
  source: () => T,
  fn?: (a: U, b: T) => boolean,
): (key: U) => boolean
```

**Example:**

```tsx
import { createSignal, createSelector } from 'fict/advanced'

function SelectableList() {
  const [selectedId, setSelectedId] = createSignal<number | null>(null)
  const isSelected = createSelector(selectedId)

  const items = [
    { id: 1, name: 'Item 1' },
    { id: 2, name: 'Item 2' },
    { id: 3, name: 'Item 3' },
  ]

  return (
    <ul>
      {items.map(item => (
        <li
          key={item.id}
          class={isSelected(item.id) ? 'selected' : ''}
          onClick={() => setSelectedId(item.id)}
        >
          {item.name}
        </li>
      ))}
    </ul>
  )
}
```

---

## Lifecycle

### onMount

Run after the component mounts and its DOM is connected.

```typescript
function onMount(fn: () => void | (() => void)): void
```

**Example:**

```tsx
import { onMount } from 'fict'

function Chart() {
  let canvasRef: HTMLCanvasElement | null = null

  onMount(() => {
    // DOM is ready
    const ctx = canvasRef?.getContext('2d')
    ctx?.fillRect(0, 0, 100, 100)

    // Optional cleanup
    return () => {
      console.log('Chart unmounted')
    }
  })

  return <canvas ref={el => (canvasRef = el)} />
}
```

> Note: `onMount` is deferred for nodes rendered into detached containers or fragments until
> they are inserted into the document.

---

### onDestroy

Run when the component is destroyed.

```typescript
function onDestroy(fn: () => void): void
```

**Example:**

```tsx
import { onDestroy } from 'fict'

function WebSocketComponent() {
  let ws: WebSocket | null = null

  onMount(() => {
    ws = new WebSocket('wss://example.com')
  })

  onDestroy(() => {
    ws?.close()
  })

  return <div>WebSocket Component</div>
}
```

---

### onCleanup

Run when the current reactive scope cleans up (usable inside an effect).

```typescript
function onCleanup(fn: () => void): void
```

**Example:**

```tsx
import { createEffect, onCleanup } from 'fict'

function Subscription() {
  let topic = $state('news')

  $effect(() => {
    const subscription = subscribe(topic)

    onCleanup(() => {
      subscription.unsubscribe()
    })
  })

  return <div>Subscribed to: {topic}</div>
}
```

---

### createRoot

Create an isolated reactive root context.

```typescript
function createRoot<T>(
  fn: () => T,
  options?: { inherit?: boolean },
): { value: T; dispose: () => void }
```

**Notes:**

- By default, `createRoot` is isolated and does not inherit error/suspense handlers.
- Use `{ inherit: true }` to link to the current root when you need boundary propagation.

**Example:**

```tsx
import { createEffect, createRoot } from 'fict'
import { createSignal } from 'fict/advanced'

// Create reactive state outside components
const { value, dispose } = createRoot(() => {
  const [count, setCount] = createSignal(0)

  createEffect(() => {
    console.log('Global count:', count())
  })

  return { count, setCount }
})

// Use global state
function Counter() {
  return <button onClick={() => value.setCount(c => c + 1)}>Global: {value.count()}</button>
}

// Clean up when done
// dispose()
```

---

## Scheduling & Control

### batch

Batch multiple updates into a single DOM flush.

```typescript
function batch<T>(fn: () => T): T
```

**Example:**

```tsx
import { batch } from 'fict'

function MultiUpdate() {
  let firstName = $state('John')
  let lastName = $state('Doe')
  let age = $state(25)

  const updateAll = () => {
    batch(() => {
      firstName = 'Jane'
      lastName = 'Smith'
      age = 30
    })
    // Only one DOM update
  }

  return (
    <div>
      <p>
        {firstName} {lastName}, {age}
      </p>
      <button onClick={updateAll}>Update All</button>
    </div>
  )
}
```

---

### untrack

Skip dependency tracking within a block.

```typescript
function untrack<T>(fn: () => T): T
```

**Example:**

```tsx
import { untrack } from 'fict'

function Logger() {
  let count = $state(0)
  let logEnabled = $state(true)

  $effect(() => {
    // Track only count, not logEnabled
    if (untrack(() => logEnabled)) {
      console.log('Count:', count)
    }
  })

  return (
    <div>
      <p>Count: {count}</p>
      <button onClick={() => count++}>Increment</button>
      <button onClick={() => (logEnabled = !logEnabled)}>Toggle logging</button>
    </div>
  )
}
```

---

### startTransition

Mark updates as low-priority transitions.

```typescript
function startTransition(fn: () => void): void
```

**Example:**

```tsx
import { startTransition } from 'fict'

function Search() {
  let query = $state('')
  let results = $state<string[]>([])

  const handleInput = (e: Event) => {
    const value = (e.target as HTMLInputElement).value
    query = value

    // Mark search result updates as low priority
    startTransition(() => {
      results = performSearch(value)
    })
  }

  return (
    <div>
      <input value={query} onInput={handleInput} />
      <ul>
        {results.map(r => (
          <li key={r}>{r}</li>
        ))}
      </ul>
    </div>
  )
}
```

---

### useTransition

Get the transition state and a start function.

```typescript
function useTransition(): [isPending: () => boolean, startTransition: (fn: () => void) => void]
```

**Example:**

```tsx
import { useTransition } from 'fict'

function HeavyUpdate() {
  let data = $state<Item[]>([])
  const [isPending, startTransition] = useTransition()

  const loadMore = () => {
    startTransition(() => {
      data = [...data, ...generateManyItems()]
    })
  }

  return (
    <div>
      {isPending() && <div class="spinner">Loading...</div>}
      <button onClick={loadMore} disabled={isPending()}>
        Load More
      </button>
      <List items={data} />
    </div>
  )
}
```

---

### useDeferredValue

Create a value that updates with lower priority.

```typescript
function useDeferredValue<T>(value: () => T): () => T
```

**Example:**

```tsx
import { useDeferredValue } from 'fict'

function SearchResults() {
  let query = $state('')
  const deferredQuery = useDeferredValue(() => query)

  // query updates immediately (fast input)
  // deferredQuery updates later (lower priority render)
  const isStale = () => query !== deferredQuery()

  return (
    <div>
      <input value={query} onInput={e => (query = e.target.value)} />
      <div style={{ opacity: isStale() ? 0.5 : 1 }}>
        <ExpensiveList query={deferredQuery()} />
      </div>
    </div>
  )
}
```

---

## DOM Rendering

### render

Render a component into a DOM container.

```typescript
function render(view: () => FictNode, container: HTMLElement): () => void // returns unmount function
```

**Example:**

```tsx
import { render } from 'fict'

function App() {
  return <div>Hello Fict!</div>
}

// Mount
const unmount = render(() => <App />, document.getElementById('app')!)

// Unmount
// unmount()
```

---

### Fragment

Return multiple elements without creating an extra DOM node.

```tsx
import { Fragment } from 'fict'

function MultipleElements() {
  return (
    <Fragment>
      <h1>Title</h1>
      <p>Paragraph</p>
    </Fragment>
  )
}

// Or shorthand
function MultipleElements() {
  return (
    <>
      <h1>Title</h1>
      <p>Paragraph</p>
    </>
  )
}
```

---

## Components

### ErrorBoundary

Capture errors in the child component tree.

```typescript
function ErrorBoundary(props: {
  fallback: FictNode | ((error: unknown, reset: () => void) => FictNode)
  onError?: (error: unknown) => void
  resetKeys?: unknown | (() => unknown)
  children: FictNode
}): FictNode
```

**Example:**

```tsx
import { ErrorBoundary } from 'fict'

function App() {
  return (
    <ErrorBoundary
      fallback={(error, reset) => (
        <div class="error">
          <h2>Something went wrong</h2>
          <p>{error.message}</p>
          <button onClick={reset}>Try again</button>
        </div>
      )}
    >
      <RiskyComponent />
    </ErrorBoundary>
  )
}

function RiskyComponent() {
  let shouldError = $state(false)

  if (shouldError) {
    throw new Error('Oops!')
  }

  return <button onClick={() => (shouldError = true)}>Trigger Error</button>
}
```

**Notes:**

- `fallback` can be a node or a function. If a function is provided, it receives the error
  and a `reset()` callback to retry rendering the children.
- `onError` runs when the boundary captures an error.
- `resetKeys` can be a value or a getter; when it changes, the boundary resets.

---

### Suspense

Handle async loading states.

```typescript
function Suspense(props: {
  fallback: FictNode | ((error?: unknown) => FictNode)
  onResolve?: () => void
  onReject?: (error: unknown) => void
  resetKeys?: unknown | (() => unknown)
  children: FictNode
}): FictNode
```

**Example:**

```tsx
import { Suspense } from 'fict'
import { lazy, resource } from 'fict/plus'

// Lazy component
const HeavyComponent = lazy(() => import('./HeavyComponent'))

// Async resource
const userResource = resource({
  fetch: async ({ signal }, id: string) => {
    const res = await fetch(`/api/users/${id}`, { signal })
    return res.json()
  },
  suspense: true,
})

function App() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <HeavyComponent />
      <UserProfile id="123" />
    </Suspense>
  )
}

function UserProfile(props: { id: string }) {
  const user = userResource.read(() => props.id)

  return (
    <div>
      <h2>{user.data?.name}</h2>
      <p>{user.data?.email}</p>
    </div>
  )
}
```

---

## Props Utilities

> [!TIP]
> **In day-to-day work, just use `mergeProps()`.** The compiler handles reactive props passing; `prop()` is only needed for edge cases.

### Core API

| Function       | Purpose                         | Frequency |
| -------------- | ------------------------------- | --------- |
| `mergeProps()` | Merge defaults / override props | Common    |
| `prop()`       | Mark reactive getter + cache    | Rare      |

### mergeProps

Merge multiple props objects while keeping them reactive.

```typescript
function mergeProps<T extends object[]>(...sources: T): MergedProps<T>
```

**Example:**

```tsx
import { mergeProps } from 'fict'

function Button(props: { class?: string; onClick?: () => void; children?: FictNode }) {
  const merged = mergeProps(
    { class: 'btn', type: 'button' }, // defaults
    props, // user input
    { 'data-component': 'Button' }, // forced overrides
  )

  return (
    <button
      class={merged.class}
      type={merged.type}
      onClick={merged.onClick}
      data-component={merged['data-component']}
    >
      {merged.children}
    </button>
  )
}
```

---

### prop

Mark a reactive getter and cache it (rare). Use when the compiler cannot detect reactive fields in dynamically built objects.

```typescript
import { prop } from 'fict'

function prop<T>(getter: () => T, options?: { unwrap?: boolean }): () => T
```

**Notes:**

- If the getter returns another prop getter, `prop()` unwraps it by default.
- Use `{ unwrap: false }` when you need to pass a prop getter through as a value.

**When to use:**

1.  **Dynamically built props objects** (compiler cannot statically analyze)
2.  **Cache expensive prop computation**

**Example 1: Dynamic props**

```tsx
import { prop } from 'fict'

function getDynamicPayload() {
  // Built at runtime; compiler cannot statically analyze
  return {
    theme: prop(() => currentTheme),
    user: prop(() => currentUser),
    staticFlag: true,
  }
}

return <Dashboard {...getDynamicPayload()} />
```

**Example 2: Cache expensive computation**

```tsx
import { prop } from 'fict'

function DataTable({ list, filter }: Props) {
  // Recompute only when list or filter changes
  const memoizedData = prop(() => expensiveFilter(list, filter))

  return <Table data={memoizedData} />
}
```

**Example 3: Forward a prop getter**

```tsx
import { prop } from 'fict'

function Wrapper(props: { getValue: () => number }) {
  // Pass the getter through as-is
  const forwarded = prop(() => props.getValue, { unwrap: false })
  return <Child getValue={forwarded} />
}
```

---

## Ref

### createRef

Create a DOM element reference.

```typescript
function createRef<T extends Element = HTMLElement>(): RefObject<T>

interface RefObject<T> {
  current: T | null
}
```

**Example:**

```tsx
import { createRef, onMount } from 'fict'

function FocusInput() {
  const inputRef = createRef<HTMLInputElement>()

  onMount(() => {
    inputRef.current?.focus()
  })

  return <input ref={inputRef} placeholder="Auto focused" />
}

// Callback ref
function CallbackRef() {
  let input: HTMLInputElement | null = null

  onMount(() => {
    input?.focus()
  })

  return <input ref={el => (input = el)} placeholder="Auto focused" />
}
```

---

## Context

The Context API passes data through the component tree without prop drilling. Use it for:

- Theme configuration
- Internationalization settings
- User authentication state
- SSR isolation
- Multi-instance support

### createContext

Create a context object.

```typescript
import { createContext } from 'fict'
// or
import { createContext } from 'fict/advanced'

function createContext<T>(defaultValue: T): Context<T>
```

**Example:**

```tsx
import { createContext } from 'fict'

// Theme context
const ThemeContext = createContext<'light' | 'dark'>('light')

// User context
const UserContext = createContext<{ name: string; role: string } | null>(null)
```

---

### useContext

Read the nearest Provider value.

```typescript
function useContext<T>(context: Context<T>): T
```

**Example:**

```tsx
import { createContext, useContext } from 'fict'

const ThemeContext = createContext('light')

function ThemedButton() {
  const theme = useContext(ThemeContext)

  return <button class={theme === 'dark' ? 'btn-dark' : 'btn-light'}>Click me</button>
}

function App() {
  return (
    <ThemeContext.Provider value="dark">
      <ThemedButton />
    </ThemeContext.Provider>
  )
}
```

---

### hasContext

Check whether a context is provided in the current tree.

```typescript
function hasContext<T>(context: Context<T>): boolean
```

**Example:**

```tsx
import { createContext, hasContext, useContext } from 'fict'

const OptionalFeatureContext = createContext<{ enabled: boolean } | null>(null)

function FeatureComponent() {
  if (hasContext(OptionalFeatureContext)) {
    const feature = useContext(OptionalFeatureContext)
    return <div>Feature enabled: {feature?.enabled}</div>
  }
  return <div>Feature not available</div>
}
```

---

### Nested Providers

Providers can be nested; inner providers override outer values:

```tsx
const ThemeContext = createContext('light')

function App() {
  return (
    <ThemeContext.Provider value="dark">
      <Header /> {/* uses dark */}
      <ThemeContext.Provider value="light">
        <Sidebar /> {/* uses light */}
      </ThemeContext.Provider>
      <Content /> {/* uses dark */}
    </ThemeContext.Provider>
  )
}
```

---

### Reactive Context Values

Because Fict components run once, pass a signal or store to make context values reactive:

```tsx
import { createContext, useContext } from 'fict'
import { createSignal } from 'fict/advanced'

// Context value contains getters
const CounterContext = createContext({
  count: () => 0,
  increment: () => {},
})

function CounterProvider(props: { children: any }) {
  const [count, setCount] = createSignal(0)

  return (
    <CounterContext.Provider
      value={{
        count,
        increment: () => setCount(c => c + 1),
      }}
    >
      {props.children}
    </CounterContext.Provider>
  )
}

function Counter() {
  const { count, increment } = useContext(CounterContext)

  return <button onClick={increment}>Count: {count()}</button>
}
```

---

## Extended API (fict/plus)

APIs imported from `fict/plus` for async resource management and lazy loading.

### resource

Create an async resource with caching, refreshing, and Suspense support.

```typescript
import { resource } from 'fict/plus'

interface ResourceResult<T> {
  readonly data: T | undefined
  readonly loading: boolean
  readonly error: unknown
  refresh: () => void
}

function resource<T, Args = void>(
  optionsOrFetcher:
    | ((ctx: { signal: AbortSignal }, args: Args) => Promise<T>)
    | ResourceOptions<T, Args>,
): {
  read(args: (() => Args) | Args): ResourceResult<T>
  invalidate(key?: unknown): void
  prefetch(args: Args, keyOverride?: unknown): void
}
```

**Basic example:**

```tsx
import { resource } from 'fict/plus'

// Simple usage
const postsResource = resource(async ({ signal }) => {
  const res = await fetch('/api/posts', { signal })
  return res.json()
})

function PostList() {
  const posts = postsResource.read()

  if (posts.loading) return <div>Loading...</div>
  if (posts.error) return <div>Error: {String(posts.error)}</div>

  return (
    <ul>
      {posts.data?.map(post => (
        <li key={post.id}>{post.title}</li>
      ))}
    </ul>
  )
}
```

**With params and cache:**

```tsx
import { resource } from 'fict/plus'

const userResource = resource({
  fetch: async ({ signal }, userId: string) => {
    const res = await fetch(`/api/users/${userId}`, { signal })
    if (!res.ok) throw new Error('Failed to fetch user')
    return res.json()
  },
  cache: {
    mode: 'memory',
    ttlMs: 5 * 60 * 1000, // 5 minutes
    staleWhileRevalidate: true, // return stale data while refreshing
  },
})

function UserCard(props: { userId: string }) {
  // Reactive parameter
  const user = userResource.read(() => props.userId)

  return (
    <div>
      {user.loading && <span>Refreshing...</span>}
      <h2>{user.data?.name}</h2>
      <button onClick={user.refresh}>Refresh</button>
    </div>
  )
}
```

**With Suspense:**

```tsx
import { resource } from 'fict/plus'
import { Suspense } from 'fict'

const dataResource = resource({
  fetch: async ({ signal }) => {
    const res = await fetch('/api/data', { signal })
    return res.json()
  },
  suspense: true, // enable Suspense mode
})

function App() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <DataDisplay />
    </Suspense>
  )
}

function DataDisplay() {
  const data = dataResource.read()
  // In Suspense mode, data.data is guaranteed
  return <div>{data.data.title}</div>
}
```

---

### lazy

Lazy-load components for code splitting.

```typescript
import { lazy } from 'fict/plus'

function lazy<TProps>(loader: () => Promise<{ default: Component<TProps> }>): Component<TProps>
```

**Example:**

```tsx
import { lazy } from 'fict/plus'
import { Suspense } from 'fict'

// Lazy components
const HeavyChart = lazy(() => import('./components/HeavyChart'))
const AdminPanel = lazy(() => import('./components/AdminPanel'))

function App() {
  let showAdmin = $state(false)

  return (
    <div>
      <Suspense fallback={<div>Loading chart...</div>}>
        <HeavyChart />
      </Suspense>

      <button onClick={() => (showAdmin = !showAdmin)}>Toggle Admin</button>

      {showAdmin && (
        <Suspense fallback={<div>Loading admin panel...</div>}>
          <AdminPanel />
        </Suspense>
      )}
    </div>
  )
}
```

---

## Advanced APIs (fict/advanced)

These APIs are for power users and library authors. They provide lower-level control over Fict's internals.

### setCycleProtectionOptions

Configure cycle protection thresholds for development mode. This helps tune cycle detection sensitivity for your application.

```typescript
import { setCycleProtectionOptions } from 'fict/advanced'

interface CycleProtectionOptions {
  maxFlushCyclesPerMicrotask?: number // Default: 10,000
  maxEffectRunsPerFlush?: number // Default: 20,000
  windowSize?: number // Default: 5
  highUsageRatio?: number // Default: 0.8
  maxRootReentrantDepth?: number // Default: 10
  enableWindowWarning?: boolean // Default: true
  devMode?: boolean // Default: false (throw instead of warn)
}

function setCycleProtectionOptions(options: CycleProtectionOptions): void
```

**Example:**

```tsx
import { setCycleProtectionOptions } from 'fict/advanced'

// For large applications
setCycleProtectionOptions({
  maxFlushCyclesPerMicrotask: 50000,
})

// Strict mode for testing
setCycleProtectionOptions({
  devMode: true,
  maxFlushCyclesPerMicrotask: 100,
})
```

> **Note:** Cycle protection only runs in development mode. In production, all guards are no-ops.

For detailed documentation, see [Cycle Protection](./cycle-protection.md).

---

## Type Definitions

### Core Types

```typescript
// Renderable node types
type FictNode = FictVNode | FictNode[] | Node | string | number | boolean | null | undefined

// Virtual node
interface FictVNode {
  type: string | symbol | Component
  props: Record<string, unknown> | null
  key?: string | undefined
}

// Component type
type Component<P = {}> = (props: P & BaseProps) => FictNode

interface BaseProps {
  key?: string | number
  children?: FictNode | FictNode[]
}

type PropsWithChildren<P = {}> = P & {
  children?: FictNode | FictNode[]
}
```

### Reactive Types

```typescript
// Signal type
type Signal<T> = [get: () => T, set: (v: T | ((prev: T) => T)) => void]

// Memo type
type Memo<T> = () => T

// Maybe reactive value
type MaybeReactive<T> = T | (() => T)

// Cleanup function
type Cleanup = () => void
```

### Style Types

```typescript
// Style value
type StyleValue = string | number

// CSS style object
type StyleProp = string | Record<string, StyleValue> | null | undefined

// Class attribute
type ClassProp = string | Record<string, boolean> | null | undefined
```

### Ref Types

```typescript
type RefCallback<T extends Element> = (element: T) => void

interface RefObject<T extends Element> {
  current: T | null
}

type Ref<T extends Element> = RefCallback<T> | RefObject<T>
```

### Event Handling

```typescript
type EventHandler<E extends Event = Event> = (event: E) => void
```

---

## List Rendering

Fict uses fine-grained keyed list reconciliation for efficient list updates.

### Keys

When rendering arrays, provide a unique `key` prop for each item:

```tsx
function TodoList() {
  let todos = $state([
    { id: 1, text: 'Learn Fict' },
    { id: 2, text: 'Build app' },
  ])

  return (
    <ul>
      {todos.map(todo => (
        <li key={todo.id}>{todo.text}</li>
      ))}
    </ul>
  )
}
```

**Key Requirements:**

| Requirement | Description                                                    |
| ----------- | -------------------------------------------------------------- |
| **Unique**  | Keys must be unique within the same list                       |
| **Stable**  | Use stable identifiers (e.g., database IDs), not array indices |
| **Type**    | Keys can be strings or numbers                                 |

**Duplicate Key Behavior:**

If duplicate keys are detected in the same list:

1. **Development mode**: A console warning is logged
2. **Behavior**: The last item with a duplicate key replaces the previous one
3. **Impact**: This may cause unexpected UI behavior and state loss

```tsx
// ⚠️ Bad: Duplicate keys
{
  items.map(item => (
    <li key={item.category}>{item.name}</li> // Multiple items may share category
  ))
}

// ✅ Good: Unique keys
{
  items.map(item => <li key={item.id}>{item.name}</li>)
}
```

> **Warning**: Always ensure keys are unique. Duplicate keys can cause items to be unexpectedly removed or replaced, leading to data loss and incorrect rendering.

---

## Full Example: Todo App

```tsx
import { $state, $effect, render, onMount } from 'fict'

interface Todo {
  id: number
  text: string
  completed: boolean
}

function TodoApp() {
  let todos = $state<Todo[]>([])
  let inputText = $state('')
  let filter = $state<'all' | 'active' | 'completed'>('all')
  let nextId = 1

  // Load from localStorage
  onMount(() => {
    const saved = localStorage.getItem('todos')
    if (saved) {
      todos = JSON.parse(saved)
      nextId = Math.max(...todos.map(t => t.id), 0) + 1
    }
  })

  // Save to localStorage
  $effect(() => {
    localStorage.setItem('todos', JSON.stringify(todos))
  })

  // Computed values
  const filteredTodos = () => {
    switch (filter) {
      case 'active':
        return todos.filter(t => !t.completed)
      case 'completed':
        return todos.filter(t => t.completed)
      default:
        return todos
    }
  }

  const activeCount = () => todos.filter(t => !t.completed).length
  const completedCount = () => todos.filter(t => t.completed).length

  // Actions
  const addTodo = () => {
    if (!inputText.trim()) return
    todos = [
      ...todos,
      {
        id: nextId++,
        text: inputText.trim(),
        completed: false,
      },
    ]
    inputText = ''
  }

  const toggleTodo = (id: number) => {
    todos = todos.map(t => (t.id === id ? { ...t, completed: !t.completed } : t))
  }

  const removeTodo = (id: number) => {
    todos = todos.filter(t => t.id !== id)
  }

  const clearCompleted = () => {
    todos = todos.filter(t => !t.completed)
  }

  return (
    <div class="todo-app">
      <h1>Todos</h1>

      {/* Input */}
      <div class="input-section">
        <input
          value={inputText}
          onInput={e => (inputText = (e.target as HTMLInputElement).value)}
          onKeyDown={e => e.key === 'Enter' && addTodo()}
          placeholder="What needs to be done?"
        />
        <button onClick={addTodo}>Add</button>
      </div>

      {/* List */}
      <ul class="todo-list">
        {filteredTodos().map(todo => (
          <li key={todo.id} class={todo.completed ? 'completed' : ''}>
            <input type="checkbox" checked={todo.completed} onChange={() => toggleTodo(todo.id)} />
            <span>{todo.text}</span>
            <button onClick={() => removeTodo(todo.id)}>Delete</button>
          </li>
        ))}
      </ul>

      {/* Footer */}
      {todos.length > 0 && (
        <div class="footer">
          <span>{activeCount()} items left</span>

          <div class="filters">
            <button class={filter === 'all' ? 'active' : ''} onClick={() => (filter = 'all')}>
              All
            </button>
            <button class={filter === 'active' ? 'active' : ''} onClick={() => (filter = 'active')}>
              Active
            </button>
            <button
              class={filter === 'completed' ? 'active' : ''}
              onClick={() => (filter = 'completed')}
            >
              Completed
            </button>
          </div>

          {completedCount() > 0 && <button onClick={clearCompleted}>Clear completed</button>}
        </div>
      )}
    </div>
  )
}

render(() => <TodoApp />, document.getElementById('app')!)
```

---

## More Resources

- [Architecture](./architecture.md) - Deep dive into Fict's execution model
- [Reactivity Semantics](./reactivity-semantics.md) - Detailed rules of the reactive system
- [Compiler Spec](./compiler-spec.md) - Compiler transformation rules
- [Framework Comparison](./framework-comparison.md) - Comparison with React, Solid, Vue, Svelte
