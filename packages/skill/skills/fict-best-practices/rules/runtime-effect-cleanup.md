---
title: Always Return Cleanup for Effectful Resources
impact: HIGH
impactDescription: prevents leaks and stale subscriptions during updates/unmount
tags: runtime, effect, cleanup, lifecycle
---

## Always Return Cleanup for Effectful Resources

Any `$effect` that creates subscriptions, timers, listeners, or async request
lifetimes should return cleanup. Missing cleanup is a common source of stale
work and memory growth.

**Incorrect (leaking listener and request):**

```tsx
function Search({ query }: { query: string }) {
  let result = $state('')

  $effect(() => {
    window.addEventListener('resize', () => console.log('resize'))
    fetch(`/api/search?q=${query}`).then(async r => {
      result = await r.text()
    })
  })

  return <div>{result}</div>
}
```

**Correct (explicit cleanup and cancellation):**

```tsx
function Search({ query }: { query: string }) {
  let result = $state('')

  $effect(() => {
    const onResize = () => console.log('resize')
    window.addEventListener('resize', onResize)

    const controller = new AbortController()
    fetch(`/api/search?q=${query}`, { signal: controller.signal })
      .then(async r => {
        result = await r.text()
      })
      .catch(() => {})

    return () => {
      window.removeEventListener('resize', onResize)
      controller.abort()
    }
  })

  return <div>{result}</div>
}
```

Reference: [Diagnostic Codes - FICT-E003](https://github.com/fictjs/fict/blob/main/docs/diagnostic-codes.md)
