---
type: contract
title: $effect
description: Public compiler-macro contract for tracked effects and cleanup.
owner: NEEDS_OWNER
status: proposed
tags: [api, effect, compiler]
---

# `$effect`

Registers a compiler-managed side effect that re-runs when a synchronously read reactive dependency changes.

```ts
function $effect(fn: () => void | (() => void)): void
```

```tsx
import { $effect } from 'fict'

function Title({ name }: { name: string }) {
  $effect(() => {
    document.title = name
    return () => {
      document.title = ''
    }
  })

  return <h1>{name}</h1>
}
```

## Callback contract

The callback runs synchronously. Reactive reads performed during that run become dependencies. It may return a cleanup function.

Cleanup runs:

1. before a dependency-triggered re-execution; and
2. when the owning root is destroyed.

An `async` function returns a Promise and therefore does not satisfy the effect callback contract. Read dependencies synchronously, launch async work, and return synchronous cancellation cleanup.

## Placement contract

`$effect` may appear at module top level or the immediate top level of a component. Conditional, looped, or nested calls are compile errors because their ownership and ordering would be ambiguous.

## Error behavior

Errors and suspension tokens are routed to the nearest corresponding component boundary. Unhandled errors escape through the scheduler or the operation that triggered the effect. Cleanup failures do not leave the effect subscribed.

## Lower-level alternative

`createEffect` from the runtime is available to library code and returns an explicit disposer:

```ts
import { createEffect } from 'fict'

const dispose = createEffect(() => {
  // tracked synchronous work
})

dispose()
```

Application components should normally prefer the compiler macro.

## Verification

- Macro declaration: `packages/fict/src/index.ts`.
- Managed runtime effect: `packages/runtime/src/effect.ts`.
- Cleanup ownership: `packages/runtime/src/lifecycle.ts`.
- Repository check: `pnpm --filter @fictjs/runtime test && pnpm --filter fict test`.
