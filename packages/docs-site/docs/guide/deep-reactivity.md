---
type: feature-spec
title: Deep reactivity
description: Use $store for path-level updates to plain records and arrays.
owner: NEEDS_OWNER
status: proposed
tags: [guide, store, reactivity]
---

# Deep Reactivity

`$store` wraps plain records and arrays in a proxy. Reads subscribe at the property path being used, and direct writes notify only consumers of the affected value or shape.

```tsx
import { $store } from 'fict'

export const account = $store({
  profile: { name: 'Ada', location: { city: 'London' } },
  roles: ['admin'],
})

account.profile.location.city = 'Paris'
account.roles.push('editor')
```

Unlike `$state`, a store can be created at module scope and shared by multiple component roots.

## What is tracked

The store observes:

- property reads and writes;
- nested plain object and array access;
- array indexes and `length`;
- additions, deletions, and `in` checks;
- key enumeration such as `Object.keys` and `for…in`;
- property descriptor changes made through reflection APIs.

```tsx
const model = $store<{ selected?: string; items: string[] }>({ items: [] })

const hasSelection = 'selected' in model
const itemCount = model.items.length
const keys = Object.keys(model)
```

Each expression becomes reactive when consumed in compiler-managed code.

## Supported object shapes

Transparent deep wrapping applies to arrays, normal object literals, and null-prototype records. Branded platform objects and class instances are opaque because proxy receivers can break internal slots or private fields.

```tsx
const state = $store({
  updatedAt: new Date(),
  controller: new AbortController(),
})

// Replace opaque values to publish a change.
state.updatedAt = new Date()
```

For `Map`, `Set`, DOM objects, dates, and class instances, expose explicit operations and replace the containing store property when consumers must update.

## Do not mutate the raw object

Always write through the proxy returned by `$store`:

```tsx
const raw = { profile: { name: 'Ada' } }
const state = $store(raw)

state.profile.name = 'Grace' // reactive
raw.profile.name = 'Lin' // bypasses store notification
```

The store preserves proxy identity for objects it has already wrapped, so passing the same stored branch through `$store` again does not create a second proxy.

## Store boundaries

Use `$state` when a value is local and replaced as a whole. Use `$store` when consumers need direct nested mutation or shared property-level subscriptions. Avoid placing every application value in one global store; smaller domain stores make ownership and invalidation easier to understand.

See the complete [`$store` API contract](/api/store).

## Verification

- Store implementation: `packages/fict/src/store.ts`.
- Compiler integration: `packages/fict/test/compiler-integration.test.ts`.
- Store behavior: `packages/fict/test/store.test.ts` and related store regression suites.
- Repository check: `pnpm --filter fict test && pnpm --filter fict-docs-site build`.
