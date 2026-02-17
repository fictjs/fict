---
title: Keep Memo Computations Pure
impact: HIGH
impactDescription: avoids unpredictable re-execution side effects
tags: runtime, memo, purity, effect
---

## Keep Memo Computations Pure

Memo bodies (`$memo` or compiler-derived memo regions) must be pure. Side
effects inside memo computations can execute multiple times and violate
scheduling expectations.

**Incorrect (side effects in memo):**

```tsx
function Counter() {
  let count = $state(0)

  const doubled = $memo(() => {
    console.log('tracking', count)
    localStorage.setItem('last', String(count))
    return count * 2
  })

  return <button onClick={() => count++}>{doubled}</button>
}
```

**Correct (pure memo + side effect in `$effect`):**

```tsx
function Counter() {
  let count = $state(0)
  const doubled = count * 2

  $effect(() => {
    localStorage.setItem('last', String(count))
  })

  return <button onClick={() => count++}>{doubled}</button>
}
```

Reference: [Diagnostic Codes - FICT-M003](https://github.com/fictjs/fict/blob/main/docs/diagnostic-codes.md)
