---
title: Prevent State Escape Outside Owning Scope
impact: CRITICAL
impactDescription: avoids lifecycle leaks and post-unmount writes
tags: reactivity, lifetime, state, safety
---

## Prevent State Escape Outside Owning Scope

Never let a `$state` binding escape the component/hook scope that owns it.
Escaped mutable state can outlive lifecycle cleanup and produce invalid updates.

**Incorrect (state escapes owner):**

```tsx
let inc: (() => void) | undefined

function Counter() {
  let count = $state(0)
  inc = () => count++
  return <div>{count}</div>
}

export function externalIncrement() {
  inc?.()
}
```

**Correct (keep ownership local or use shared primitives):**

```tsx
import { createSignal } from 'fict/advanced'

const sharedCount = createSignal(0)

export function externalIncrement() {
  sharedCount(sharedCount() + 1)
}

function Counter() {
  return <div>{sharedCount()}</div>
}
```

Reference: [Diagnostic Codes - FICT-S001/FICT-S002](https://github.com/fictjs/fict/blob/main/docs/diagnostic-codes.md)
