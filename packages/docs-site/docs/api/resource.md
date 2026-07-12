---
type: contract
title: resource
description: Async data contract for cancellation, caching, mutation, and optional Suspense.
owner: NEEDS_OWNER
status: proposed
tags: [api, async, cache, suspense]
---

# `resource`

Creates a keyed async data resource with reactive status, request cancellation, race protection, caching, optimistic mutation, and optional Suspense.

```ts
function resource<T, Args = void>(
  fetcher: (ctx: { signal: AbortSignal }, args: Args) => Promise<T>,
): Resource<T, Args>

function resource<T, Args = void>(options: ResourceOptions<T, Args>): Resource<T, Args>
```

Import it from the async entry point:

```tsx
import { resource } from 'fict/plus'
```

## Basic use

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
  if (user.error) return <button onClick={user.refresh}>Retry</button>
  return <h1>{user.data?.name}</h1>
}
```

Pass static arguments directly. Wrap a changing accessor with `reactive` so `resource` can distinguish it from an ordinary function value.

## `ResourceResult<T>`

```ts
interface ResourceResult<T> {
  readonly data: T | undefined
  readonly loading: boolean
  readonly error: unknown
  refresh(): void
}
```

The fields are live getters. While stale-while-revalidate is fetching, cached data stays visible and `loading` stays false. A terminal fetch error sets `error`, clears `loading`, and clears `data`. `refresh()` invalidates the active entry and schedules a new fetch.

## Options

```ts
interface ResourceOptions<T, Args> {
  fetch: (ctx: { signal: AbortSignal }, args: Args) => Promise<T>
  key?: unknown | ((args: Args) => unknown)
  suspense?: boolean
  reset?: unknown | (() => unknown)
  cache?: ResourceCacheOptions
}
```

- `key` overrides request identity. Plain-data keys are structurally normalized.
- `suspense` makes `data` throw a Suspense token while the initial value is pending.
- `reset` clears the current value when its static value or explicitly reactive getter changes.
- The fetcher's `AbortSignal` is aborted when superseded work must be cancelled.

## Cache options

```ts
interface ResourceCacheOptions {
  mode?: 'memory' | 'none'
  scope?: 'request' | 'shared'
  ttlMs?: number
  staleWhileRevalidate?: boolean
  cacheErrors?: boolean
  maxEntries?: number
}
```

Defaults are memory caching, request-scoped SSR entries, infinite TTL, no stale-while-revalidate, no cached errors, and at most 256 entries. In the browser, memory caching is scoped to the resource instance. Use `scope: 'shared'` during SSR only for data that is safe to share across requests.

## Resource methods

```ts
interface Resource<T, Args> {
  read(args: Args | (() => Args)): ResourceResult<T>
  invalidate(key?: unknown): void
  prefetch(args: Args, keyOverride?: unknown): void
  mutate(
    args: Args | (() => Args),
    value: T | ((previous: T | undefined) => T),
    options?: { key?: unknown; revalidate?: boolean },
  ): void
}
```

- `invalidate()` aborts and removes all entries; a key limits it to one normalized entry.
- `prefetch()` starts missing work without creating a Suspense token.
- `mutate()` writes an optimistic cached value and cancels obsolete in-flight work. Set `revalidate: true` to fetch again.

## Suspense

```tsx
import { ErrorBoundary, Suspense } from 'fict'
import { reactive } from 'fict/advanced'
import { resource } from 'fict/plus'

const profile = resource({
  fetch: ({ signal }, id: string) => loadProfile(id, signal),
  suspense: true,
})

function Profile({ id }: { id: string }) {
  const result = profile.read(reactive(() => id))
  return <h1>{result.data?.name}</h1>
}

function App() {
  return (
    <ErrorBoundary fallback={error => <p>Failed: {String(error)}</p>}>
      <Suspense fallback={<p>Loading…</p>}>
        <Profile id="42" />
      </Suspense>
    </ErrorBoundary>
  )
}
```

## Verification

- Types and implementation: `packages/fict/src/resource.ts`.
- Suspense boundary: `packages/runtime/src/suspense.ts`.
- Behavioral coverage: `packages/fict/test/resource.test.ts` and `packages/fict/test/compiler-integration.test.ts`.
- Repository check: `pnpm --filter fict test`.
