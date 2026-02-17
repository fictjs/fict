---
title: Keep Macros at Top-Level Component or Hook Scope
impact: CRITICAL
impactDescription: prevents unsupported macro placement and undefined ordering
tags: compiler, macros, state, effect
---

## Keep Macros at Top-Level Component or Hook Scope

`$state`, `$effect`, and `$memo` must be declared at top-level scope of a
component or hook body. Do not place them inside loops, conditions, or nested
functions.

**Incorrect (unsupported placement):**

```tsx
function Counter({ enabled }: { enabled: boolean }) {
  if (enabled) {
    let count = $state(0)
    $effect(() => console.log(count))
  }

  function setup() {
    let local = $state(1)
    return local
  }

  return null
}
```

**Correct (stable declaration order):**

```tsx
function Counter({ enabled }: { enabled: boolean }) {
  let count = $state(0)

  $effect(() => {
    if (!enabled) return
    console.log(count)
  })

  return <button onClick={() => count++}>{count}</button>
}
```

Reference: [Fict Architecture - createSignal vs $state](https://github.com/fictjs/fict/blob/main/docs/architecture.md)
