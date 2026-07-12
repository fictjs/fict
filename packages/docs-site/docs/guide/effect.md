---
type: feature-spec
title: Reactive effects
description: Synchronize reactive values with external systems using $effect and deterministic cleanup.
owner: NEEDS_OWNER
status: proposed
tags: [guide, reactivity, lifecycle]
---

# Reactive Effects

`$effect` runs a synchronous callback, tracks reactive values read during that callback, and re-runs it when those dependencies change.

```tsx
function Page() {
  let title = $state('Dashboard')

  $effect(() => {
    document.title = title
  })

  return <input value={title} onInput={event => (title = event.currentTarget.value)} />
}
```

Use effects to synchronize with browser APIs, timers, subscriptions, logging, or imperative libraries. Compute display values with normal expressions instead.

## Cleanup

Return a function to stop work created by the current run. Cleanup executes before the effect re-runs and again when its owner is destroyed.

```tsx
import { createSignal } from 'fict/advanced'

function Clock() {
  const now = createSignal(Date.now())

  $effect(() => {
    const timer = window.setInterval(() => {
      now(Date.now())
    }, 1_000)

    return () => window.clearInterval(timer)
  })

  return <time>{now()}</time>
}
```

The runtime also supports `onCleanup(fn)` inside low-level `createEffect` utilities. Returning cleanup from `$effect` is usually clearer in components.

## Placement and tracking

Place `$effect` at module top level or the immediate top level of a component. Conditional, looped, or nested `$effect` calls are compile errors.

Only synchronous reads establish dependencies. An `async` effect callback returns a Promise instead of cleanup and is rejected by the public type contract. Passing a closure that reads or writes implicit reactive variables through an unknown Promise boundary also fails strict-guarantee compilation. For request results that update UI, cancellation, cache keys, and Suspense, use [`resource`](/api/resource). Library integrations that require manual Promise control should use explicit accessors such as `createSignal`; see [Async Work](/guide/async).

## Avoid write cycles

An effect that reads and writes the same dependency can schedule itself indefinitely:

```tsx
// Avoid
$effect(() => {
  count = count + 1
})
```

Use a derived expression, an event handler, `untrack`, or a guarded comparison depending on the intended data flow. Fict's cycle protection reports runaway reactive updates in development.

See the complete [`$effect` API contract](/api/effect).

## Verification

- Macro contract: `packages/fict/src/index.ts`.
- Runtime effect and cleanup: `packages/runtime/src/effect.ts` and `packages/runtime/src/lifecycle.ts`.
- Placement rules: `docs/compiler-spec.md`.
- Repository check: `pnpm --filter @fictjs/runtime test && pnpm --filter fict-docs-site build`.
