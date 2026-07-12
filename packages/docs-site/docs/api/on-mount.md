---
type: contract
title: onMount
description: Lifecycle contract for work that starts after a component root commits to the DOM.
owner: NEEDS_OWNER
status: proposed
tags: [api, lifecycle, dom]
---

# `onMount`

Queues a callback for the current root after its DOM has been committed and refs have been assigned.

```ts
function onMount(fn: () => void | (() => void)): void
```

```tsx
import { createRef, onMount } from 'fict'

function SearchBox() {
  const input = createRef<HTMLInputElement>()

  onMount(() => {
    input.current?.focus()

    const observer = new ResizeObserver(() => {
      // respond to size changes
    })
    if (input.current) observer.observe(input.current)

    return () => observer.disconnect()
  })

  return <input ref={input} type="search" />
}
```

## Timing

- A callback registered during initial rendering runs after the root commits.
- A callback registered against an already mounted root is flushed immediately.
- A callback queued on a root that is destroyed before mounting is discarded.
- A call with no active root executes immediately; application code should normally call `onMount` only while setting up a component/root.

The callback is untracked, so reactive values read inside it do not turn mount handling into an effect.

## Cleanup

If the callback returns a function, the runtime registers it as root cleanup. It runs during unmount even when another cleanup reports an error.

Use `$effect` when work must re-run with reactive dependencies. Use `onMount` when it should start once per mounted root.

## Verification

- Lifecycle implementation: `packages/runtime/src/lifecycle.ts`.
- DOM commit ordering: `packages/runtime/src/dom.ts`.
- Behavior tests: `packages/runtime/test/dom.test.ts` and `packages/runtime/test/index.test.ts`.
- Repository check: `pnpm --filter @fictjs/runtime test`.
