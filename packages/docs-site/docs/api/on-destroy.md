---
type: contract
title: onDestroy
description: Lifecycle contract for deterministic component-root teardown.
owner: NEEDS_OWNER
status: proposed
tags: [api, lifecycle, cleanup]
---

# `onDestroy`

Registers a callback on the current root. The callback runs when that root is destroyed.

```ts
function onDestroy(fn: () => void | (() => void)): void
```

```tsx
import { onDestroy } from 'fict'

function LiveFeed() {
  const connection = connectToFeed()

  onDestroy(() => {
    connection.close()
  })

  return <section>Connected</section>
}
```

## Teardown contract

- Destruction is idempotent; callbacks run at most once for a root.
- Runtime root cleanups run before registered destroy callbacks.
- Newly registered cleanup/destroy work discovered during teardown is drained before destruction finishes.
- If callbacks throw, the runtime continues draining the remaining work and reports the first unhandled error afterward.
- A call with no active root executes immediately.

If an `onDestroy` callback itself returns a function, that function executes immediately as part of the same lifecycle dispatch. Prefer placing all teardown in the registered callback for clarity.

## Choosing a cleanup API

| Work                                    | API                           |
| --------------------------------------- | ----------------------------- |
| One-time root teardown                  | `onDestroy`                   |
| Setup after DOM commit, paired teardown | return cleanup from `onMount` |
| Dependency-scoped teardown              | return cleanup from `$effect` |
| Low-level effect cleanup registration   | `onCleanup`                   |

Calling the unmount function returned by `render` destroys the root and therefore triggers `onDestroy`.

## Verification

- Lifecycle implementation: `packages/runtime/src/lifecycle.ts`.
- Root unmount: `packages/runtime/src/dom.ts`.
- Cleanup resilience tests: `packages/runtime/test/memory-lifecycle.test.ts` and `packages/runtime/test/index.test.ts`.
- Repository check: `pnpm --filter @fictjs/runtime test`.
