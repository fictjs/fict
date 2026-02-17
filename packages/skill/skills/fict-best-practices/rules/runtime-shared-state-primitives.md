---
title: Use the Right Primitive for Shared State Boundaries
impact: HIGH
impactDescription: avoids accidental scope leaks and unnecessary recomputation
tags: runtime, state, store, signal
---

## Use the Right Primitive for Shared State Boundaries

Use `$state` for component-local state only. For cross-component or module-level
state, prefer `$store` (deep object reactivity) or `createSignal` (scalar or
library-level signal).

**Incorrect (module-level `$state`):**

```tsx
let globalCount = $state(0)

export function useGlobalCounter() {
  return {
    value: globalCount,
    inc: () => globalCount++,
  }
}
```

**Correct (shared primitives for shared ownership):**

```tsx
import { $store } from 'fict'
import { createSignal } from 'fict/advanced'

export const session = $store({ user: null as null | { id: string } })
export const globalCount = createSignal(0)

export function useGlobalCounter() {
  return {
    value: globalCount,
    inc: () => globalCount(globalCount() + 1),
  }
}
```

Reference: [API Reference - $state vs $store vs createSignal](https://github.com/fictjs/fict/blob/main/docs/api-reference.md)
