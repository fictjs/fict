---
title: Keep Props and Object Shaping Statically Analyzable
impact: CRITICAL
impactDescription: preserves reactive props instead of fallback snapshots
tags: reactivity, props, destructuring, spread
---

## Keep Props and Object Shaping Statically Analyzable

Prefer simple prop access/destructuring and explicit object shapes. Highly
dynamic computed keys and unknown spread shapes can force fallback behavior.

**Incorrect (dynamic shape that is hard to prove):**

```tsx
function Badge(props: Record<string, unknown>, key: string) {
  const payload = { ...props, [key]: props[key] }
  return <span {...payload} />
}
```

**Correct (explicit fields or mergeProps boundary):**

```tsx
import { mergeProps, prop } from 'fict'

function Badge(props: { label: string; active: boolean }) {
  const merged = mergeProps(
    { role: 'status' },
    {
      label: prop(() => props.label),
      active: prop(() => props.active),
    },
  )

  return <span aria-label={String(merged.label)} data-active={String(merged.active)} />
}
```

Reference: [Fict Architecture - Props reactivity](https://github.com/fictjs/fict/blob/main/docs/architecture.md)
