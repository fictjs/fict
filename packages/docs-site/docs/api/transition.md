---
type: contract
title: Transition API
description: Low-priority scheduling contract for responsive reactive updates.
owner: NEEDS_OWNER
status: proposed
tags: [api, scheduler, transition]
---

# Transition API

Transitions mark reactive writes as low priority so normal input and event updates are drained first. They change scheduler priority; they do not move synchronous computation to another thread or provide time slicing.

All transition APIs are exported from `fict`.

## `startTransition`

```ts
function startTransition(fn: () => void): void
```

Updates performed synchronously inside `fn` enter the low-priority queue. The previous transition context is restored even if the callback throws, and the error is rethrown after flush scheduling is requested.

```tsx
import { $state, startTransition } from 'fict'

function Search() {
  let query = $state('')
  let results = $state<Result[]>([])

  const update = (value: string) => {
    query = value
    startTransition(() => {
      results = searchIndex(value)
    })
  }

  return <SearchView query={query} results={results} onInput={update} />
}
```

## `useTransition`

```ts
function useTransition(): [
  isPending: () => boolean,
  start: (fn: () => void | PromiseLike<unknown>) => void,
]
```

```tsx
const [isPending, start] = useTransition()

const applyFilter = (filter: Filter) => {
  start(() => {
    activeFilter = filter
  })
}

return (
  <button disabled={isPending()} onClick={() => applyFilter(next)}>
    Apply
  </button>
)
```

For synchronous callbacks, `isPending()` remains true for at least one microtask so UI can observe it. When the callback returns a PromiseLike, pending remains true until it settles. Only writes in the synchronous portion of the callback inherit transition priority; writes after an `await` occur after that transition context has exited.

Synchronous exceptions are rethrown. Rejected asynchronous transition results are reported to `console.error`, and pending state is still cleared.

## `useDeferredValue`

```ts
function useDeferredValue<T>(getValue: () => T): () => T
```

Returns an accessor whose updates are scheduled at low priority:

```tsx
import { useDeferredValue } from 'fict'

function Results({ query }: { query: string }) {
  const deferredQuery = useDeferredValue(() => query)
  const matches = searchIndex(deferredQuery())
  return <ResultList items={matches} />
}
```

The initial source value is read immediately. Later source changes are tracked by an owned effect and copied to the deferred signal inside `startTransition`.

## Verification

- Public implementation: `packages/runtime/src/transition.ts`.
- Priority queues: `packages/runtime/src/signal.ts`.
- Scheduler coverage: transition tests under `packages/runtime/test`.
- Repository check: `pnpm --filter @fictjs/runtime test && pnpm --filter fict-docs-site build`.
