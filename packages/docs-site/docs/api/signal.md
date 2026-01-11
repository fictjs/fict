# createSignal (Advanced)

`createSignal` is an **advanced/escape-hatch** API for creating reactive primitives. For most use cases, prefer the higher-level APIs.

## When to Use What

| Use Case                                            | Recommended API                    |
| --------------------------------------------------- | ---------------------------------- |
| Component-local state                               | `$state` (compiler-transformed)    |
| Derived values                                      | `$derived` or plain JS expressions |
| Cross-component (large objects, deep mutation)      | `$store`                           |
| Cross-component (scalar/lightweight, library-level) | `createSignal`                     |
| Cross-component (subtree scope, SSR isolation)      | `Context`                          |

## API Reference

### `createSignal<T>(initialValue: T): Signal<T>`

Creates a reactive signal with getter/setter combined in one function.

```tsx
import { createSignal } from 'fict/advanced'

const count = createSignal(0)

// Read value
console.log(count()) // 0

// Write value
count(5)
console.log(count()) // 5
```

**Parameters:**

- `initialValue: T` - The initial value of the signal

**Returns:** A `Signal<T>` function that:

- When called with no arguments: returns the current value
- When called with an argument: sets the new value

## Use Cases

### 1. Global/Shared State

When you need a simple value shared across components without prop drilling:

```tsx
// stores/counter.ts
import { createSignal } from 'fict/advanced'

export const globalCount = createSignal(0)
export const increment = () => globalCount(globalCount() + 1)
export const decrement = () => globalCount(globalCount() - 1)
```

```tsx
// components/Counter.tsx
import { globalCount, increment, decrement } from '../stores/counter'

function Counter() {
  return (
    <div>
      <button onClick={decrement}>-</button>
      <span>{globalCount()}</span>
      <button onClick={increment}>+</button>
    </div>
  )
}
```

### 2. Library-Level Primitives

When building reusable reactive utilities:

```tsx
import { createSignal, createEffect } from 'fict/advanced'

// A reactive timer utility
export function createTimer(intervalMs: number) {
  const elapsed = createSignal(0)
  let intervalId: number | null = null

  const start = () => {
    if (intervalId) return
    intervalId = setInterval(() => {
      elapsed(elapsed() + intervalMs)
    }, intervalMs)
  }

  const stop = () => {
    if (intervalId) {
      clearInterval(intervalId)
      intervalId = null
    }
  }

  const reset = () => {
    elapsed(0)
  }

  return { elapsed, start, stop, reset }
}
```

### 3. Integration with External Systems

When bridging reactive state with external APIs:

```tsx
import { createSignal } from 'fict/advanced'

// Reactive wrapper for localStorage
export function createPersistedSignal<T>(key: string, defaultValue: T) {
  const stored = localStorage.getItem(key)
  const initial = stored ? JSON.parse(stored) : defaultValue
  const signal = createSignal<T>(initial)

  // Original setter
  const originalSet = signal

  // Wrapped setter that also persists
  const persistedSignal = ((value?: T) => {
    if (arguments.length === 0) {
      return signal()
    }
    localStorage.setItem(key, JSON.stringify(value))
    return originalSet(value!)
  }) as typeof signal

  return persistedSignal
}
```

## Why Advanced?

`createSignal` is marked as advanced because:

1. **$state is safer** - Compiler-transformed `$state` ensures proper scoping and prevents common mistakes
2. **$store is more ergonomic** - For objects/arrays, `$store` allows direct mutation syntax
3. **Signals are lower-level** - They require manual getter/setter calls (`count()` vs `count`)

## Comparison with $state

```tsx
// Using $state (recommended for component-local state)
function Counter() {
  let count = $state(0) // Compiler transforms this

  return (
    <div>
      <span>{count}</span> {/* Direct access */}
      <button onClick={() => count++}>+</button> {/* Direct mutation */}
    </div>
  )
}

// Using createSignal (for cross-component sharing)
import { createSignal } from 'fict/advanced'

const count = createSignal(0)

function Counter() {
  return (
    <div>
      <span>{count()}</span> {/* Getter call required */}
      <button onClick={() => count(count() + 1)}>+</button> {/* Setter call required */}
    </div>
  )
}
```

## Comparison with $store

```tsx
// Using $store (recommended for shared objects)
import { $store } from 'fict'

const user = $store({ name: 'Alice', age: 25 })

// Direct mutation
user.name = 'Bob'
user.age++

// Using createSignal (more verbose for objects)
import { createSignal } from 'fict/advanced'

const user = createSignal({ name: 'Alice', age: 25 })

// Must replace entire object
user({ ...user(), name: 'Bob' })
user({ ...user(), age: user().age + 1 })
```

## TypeScript

Full TypeScript support with type inference:

```tsx
import { createSignal, type Signal } from 'fict/advanced'

// Type is inferred
const count = createSignal(0) // Signal<number>

// Explicit type
const user = createSignal<User | null>(null) // Signal<User | null>

// In function signatures
function useCounter(initial: number): {
  count: Signal<number>
  increment: () => void
} {
  const count = createSignal(initial)
  return {
    count,
    increment: () => count(count() + 1),
  }
}
```

## Import Paths

```tsx
// Import from advanced (createSignal is an escape hatch API)
import { createSignal } from 'fict/advanced'
```
