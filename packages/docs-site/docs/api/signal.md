---
type: contract
title: createSignal
description: Advanced shared-scalar and library-level reactive primitive contract.
owner: NEEDS_OWNER
status: proposed
tags: [api, advanced, signal]
---

# `createSignal` (Advanced)

Creates a reactive cell whose callable accessor combines reads and writes.

```ts
function createSignal<T>(initialValue: T): Signal<T>

interface Signal<T> {
  (): T
  (value: T): void
}
```

```tsx
import { createSignal } from 'fict/advanced'

const count = createSignal(0)

count() // read: 0
count(5) // write
count() // read: 5
```

## Choosing the API

| Use case                           | Recommended API                                               |
| ---------------------------------- | ------------------------------------------------------------- |
| Component-local state              | `$state`                                                      |
| Derived component value            | Plain JavaScript expression; `$memo` for an explicit accessor |
| Shared object with deep mutation   | `$store`                                                      |
| Shared scalar or library primitive | `createSignal`                                                |
| Subtree scope and SSR isolation    | Context                                                       |

`createSignal` is an escape hatch because application components normally benefit from compiler-managed `$state` syntax and ownership.

## Shared scalar

```tsx
// counter.ts
import { createSignal } from 'fict/advanced'

export const count = createSignal(0)
export const increment = () => count(count() + 1)
```

Consumers call the accessor explicitly:

```tsx
import { count, increment } from './counter'

function Counter() {
  return <button onClick={increment}>{count()}</button>
}
```

## Library wrapper

Use argument count—not the truthiness of the value—to distinguish a read from a write. A rest parameter works inside an arrow function and does not accidentally capture an outer `arguments` object:

```ts
import { createSignal, type Signal } from 'fict/advanced'

export function createPersistedSignal<T>(key: string, defaultValue: T): Signal<T> {
  const stored = localStorage.getItem(key)
  let initial = defaultValue

  if (stored !== null) {
    try {
      initial = JSON.parse(stored) as T
    } catch {
      localStorage.removeItem(key)
    }
  }

  const source = createSignal(initial)

  return ((...args: [] | [T]) => {
    if (args.length === 0) return source()

    const value = args[0]
    const encoded = JSON.stringify(value)
    if (encoded === undefined) {
      throw new TypeError('Persisted signals require a JSON-serializable value')
    }
    localStorage.setItem(key, encoded)
    source(value)
  }) as Signal<T>
}
```

This supports falsy values because the overload is selected by argument presence. The utility intentionally rejects values that JSON cannot serialize.

## Effects and equality

Reading a signal inside `createEffect`, `$memo`, or another tracked runtime computation subscribes that consumer. Writing a strictly equal value does not schedule redundant work; as with JavaScript `!==`, `NaN` is treated as changed.

## Verification

- Public advanced export: `packages/fict/src/advanced.ts`.
- Runtime types and implementation: `packages/runtime/src/signal.ts` and `packages/runtime/src/advanced.ts`.
- Behavioral coverage: `packages/runtime/test` signal and effect suites.
- Repository check: `pnpm --filter @fictjs/runtime test && pnpm --filter fict-docs-site build`.
