---
type: feature-spec
title: Async work
description: Run asynchronous work without losing reactive dependencies, cleanup, or request ordering.
owner: NEEDS_OWNER
status: proposed
tags: [guide, async, resource]
---

# Async Work

Reactive dependency collection is synchronous. Reads before the first `await` can be tracked; reads after it occur outside the active effect. Keep effect callbacks synchronous and launch asynchronous work from them.

## Prefer `resource` for request state

`resource` provides loading and error state, cancellation, caching, race protection, prefetching, mutation, and optional Suspense integration.

```tsx
import { resource } from 'fict/plus'
import { reactive } from 'fict/advanced'

interface User {
  id: string
  name: string
}

const users = resource<User, string>(({ signal }, id) =>
  fetch(`/api/users/${id}`, { signal }).then(response => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return response.json() as Promise<User>
  }),
)

function UserProfile({ id }: { id: string }) {
  const user = users.read(reactive(() => id))

  if (user.loading) return <p>Loading…</p>
  if (user.error) return <button onClick={user.refresh}>Try again</button>
  return <h1>{user.data?.name}</h1>
}
```

The `reactive` marker tells a low-level API that the function is an accessor, not an ordinary callback. Static arguments can be passed directly.

## Manual asynchronous effects

Use explicit runtime accessors when a library integration genuinely needs manual Promise control:

```tsx
import { createEffect } from 'fict'
import { createSignal } from 'fict/advanced'

interface Preferences {
  theme: 'light' | 'dark'
}

export function createPreferencesSync(initial: Preferences) {
  const preferences = createSignal(initial)

  const dispose = createEffect(() => {
    const snapshot = preferences()
    const controller = new AbortController()

    void persistPreferences(snapshot, controller.signal).catch(error => {
      if (!controller.signal.aborted) reportError(error)
    })

    return () => controller.abort()
  })

  return { preferences, dispose }
}
```

The synchronous `preferences()` read is tracked. Cleanup aborts obsolete work before the next effect run, and the returned disposer allows an owner to stop the integration. The asynchronous callback captures no implicit reactive values: strict guarantee mode rejects such closures when they escape through Promise callbacks. Model UI-facing async results with `resource` whenever possible.

## Async transitions

`useTransition` keeps its pending accessor true until a returned PromiseLike settles:

```tsx
import { useTransition } from 'fict'

const [isPending, start] = useTransition()

const save = () => {
  start(async () => {
    await saveDraft()
  })
}
```

The transition schedules reactive updates at low priority; it does not make CPU-heavy synchronous JavaScript run on another thread.

## Error handling

- Handle expected request errors through `resource.error` or local Promise rejection handling.
- Use `ErrorBoundary` for render/effect failures that should replace a subtree.
- Use `Suspense` with `resource({ suspense: true })` for declarative pending UI.
- Never leave a fire-and-forget Promise without an explicit rejection path.

Read the full [`resource` contract](/api/resource) for cache and SSR behavior.

## Verification

- Resource implementation: `packages/fict/src/resource.ts`.
- Effect tracking boundary: `packages/runtime/src/effect.ts`.
- Transition Promise handling: `packages/runtime/src/transition.ts`.
- Repository check: `pnpm --filter fict test && pnpm --filter fict-docs-site build`.
