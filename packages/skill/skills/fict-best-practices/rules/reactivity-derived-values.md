---
title: Use Compiler-Derived Values Instead of Manual Snapshots
impact: CRITICAL
impactDescription: prevents stale reads and keeps reactive graph complete
tags: reactivity, derived, memo, semantics
---

## Use Compiler-Derived Values Instead of Manual Snapshots

When a value is derived from `$state`/`$store`, express it as a normal derived
binding (`const x = ...`) so Fict can track and memoize it. Avoid capturing a
one-time snapshot unless that behavior is intentional.

**Incorrect (stale snapshot):**

```tsx
function Counter() {
  let count = $state(0)
  const doubled = count() * 2 // snapshot now, not a live derived binding

  $effect(() => {
    console.log(doubled)
  })

  return <button onClick={() => count++}>{doubled}</button>
}
```

**Correct (live derived binding):**

```tsx
function Counter() {
  let count = $state(0)
  const doubled = count * 2

  $effect(() => {
    console.log(doubled)
  })

  return <button onClick={() => count++}>{doubled}</button>
}
```

Reference: [Reactivity Semantics - Rule 1](https://github.com/fictjs/fict/blob/main/docs/reactivity-semantics.md)
