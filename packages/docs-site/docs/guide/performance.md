---
type: feature-spec
title: Performance
description: Keep Fict applications responsive by choosing the right reactive granularity and scheduler tools.
owner: NEEDS_OWNER
status: proposed
tags: [guide, performance, scheduling]
---

# Performance

Fict's default strategy is already fine-grained: components set up once, derived values are memoized, and DOM bindings subscribe directly to their dependencies. Start with clear code and measure before adding scheduling or caching.

## Choose the right granularity

`$state` invalidates consumers of the whole stored value. `$store` tracks plain object and array properties independently.

```tsx
// Good for replace-by-value local state.
let filters = $state({ query: '', page: 1 })
filters = { ...filters, query: 'fict' }

// Good for deep shared updates.
const dashboard = $store({ charts: { sales: [], traffic: [] } })
dashboard.charts.sales.push(nextPoint)
```

Split unrelated high-frequency values rather than forcing them through one coarse state object.

## Keep derivations pure

Plain reactive expressions can be cached, reordered within compiler constraints, or inlined. Do not put side effects in a derived expression. Use `$effect` for external synchronization.

Use `$memo` only when you need an explicit accessor or memo node; wrapping every expression manually usually adds noise without improving the generated graph.

## Key dynamic lists

Stable keys let the runtime move and retain existing nodes instead of recreating them:

```tsx
{
  rows.map(row => <Row key={row.id} row={row} />)
}
```

Use domain identity, not the current array index, for reorderable data.

## Batch related writes

`batch` postpones flushing until a group of synchronous writes completes:

```tsx
import { batch } from 'fict'

batch(() => {
  profile.name = nextName
  profile.email = nextEmail
  status = 'saved'
})
```

Event processing already benefits from scheduler coalescing; use an explicit batch when a library operation performs several related writes and intermediate states are not meaningful.

## Deprioritize expensive updates

Use `startTransition`, `useTransition`, or `useDeferredValue` when input feedback must stay ahead of expensive reactive work.

```tsx
const deferredQuery = useDeferredValue(() => query)
const results = searchIndex(deferredQuery())
```

Transitions change scheduling priority. They do not move synchronous work off the main thread; use a Worker when computation itself must run in parallel.

## Bound async caches

`resource` caches up to 256 entries per instance by default. For unbounded key spaces, set `cache.maxEntries`, choose a finite `ttlMs`, or use `mode: 'none'` when reuse is not useful.

## Avoid accidental dependencies

Use `untrack(() => value)` when an effect needs the current value but must not subscribe to it. This is an escape hatch; first consider whether the data flow is better represented as a derivation or event.

## Measure the graph

Use browser performance tools and Fict DevTools to inspect repeated effects, large reactive fan-out, list churn, and long synchronous tasks. Optimize the measured hot path rather than component count alone.

## Verification

- Scheduler and batching: `packages/runtime/src/signal.ts` and `packages/runtime/src/transition.ts`.
- Store granularity: `packages/fict/src/store.ts`.
- Compiler invariants: `docs/compiler-pass-invariants.md`.
- Repository check: `pnpm --filter @fictjs/runtime test && pnpm --filter fict-docs-site build`.
