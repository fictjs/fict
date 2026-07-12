---
type: contract
title: $store
description: Public deep-reactive proxy contract for shared plain objects and arrays.
owner: NEEDS_OWNER
status: proposed
tags: [api, store, reactivity]
---

# `$store`

Creates a deep-reactive proxy for a plain record or array.

```ts
function $store<T extends object>(initialValue: T): T
```

```tsx
import { $store } from 'fict'

const session = $store({
  user: { name: 'Ada', roles: ['admin'] },
  online: true,
})

session.user.name = 'Grace'
session.user.roles.push('editor')
```

## Reactivity contract

The proxy tracks value reads at property-path granularity. It also tracks shape operations, including array length, key enumeration, the `in` operator, deletion, and property descriptor changes.

Direct mutation through the returned proxy publishes updates:

```tsx
session.online = false
delete session.user.nickname
session.user.roles.splice(0, 1)
```

Mutating the original raw object bypasses notification and is unsupported.

## Supported values

Arrays, normal plain objects, and null-prototype records are wrapped recursively. Class instances and branded platform objects such as `Date`, `Map`, `Set`, DOM nodes, and `AbortController` remain opaque so their internal slots and private fields keep the correct receiver.

Replace an opaque property when the store should publish a change:

```tsx
const model = $store({ lastUpdated: new Date() })
model.lastUpdated = new Date()
```

Functions are returned with the store proxy as their receiver, and their identity is preserved until the property changes.

## Identity

- Passing an existing store proxy to `$store` returns the same proxy.
- Re-wrapping the same raw object returns its cached proxy.
- Nested wrappable objects are proxied lazily when read.

## Scope

Unlike `$state`, `$store` may be called at module scope for shared state. Keep stores domain-focused and avoid sharing request-specific server state across SSR requests unless the application creates it per request.

## `$state` comparison

| Behavior            | `$state`                | `$store`        |
| ------------------- | ----------------------- | --------------- |
| Component ownership | Required                | Optional        |
| Nested tracking     | Whole value             | Property path   |
| Update style        | Replace value           | Direct mutation |
| Runtime mechanism   | Compiler-lowered signal | Proxy           |

## Verification

- Public export and contract: `packages/fict/src/index.ts`.
- Proxy implementation: `packages/fict/src/store.ts`.
- Behavioral coverage: `packages/fict/test/store.test.ts` and store regression suites.
- Repository check: `pnpm --filter fict test`.
