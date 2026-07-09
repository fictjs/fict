# @fictjs/runtime

![Node CI](https://github.com/fictjs/fict/workflows/CI/badge.svg)
![npm](https://img.shields.io/npm/v/fict.svg)
![license](https://img.shields.io/npm/l/fict)

Fict reactive runtime

## Usage

```bash
npm install @fictjs/runtime
# or
yarn add @fictjs/runtime
```

You can visit [Fict](https://github.com/fictjs/fict) for more documentation.

## Package Surfaces

- `@fictjs/runtime`: low-level public runtime API. It does not export compiler macros.
- `@fictjs/runtime/advanced`: advanced reactive primitives and escape hatches.
- `@fictjs/runtime/loader`: SSR/resume loader entrypoint.
- `@fictjs/runtime/internal`: compiler ABI for generated code only; do not import by hand.

## Resumable Snapshot Loader

The current SSR writer emits snapshot schema v2. The loader rejects missing
versions, v1, and other unsupported versions by default; it never guesses which
historical value codec produced cached HTML.

Applications that intentionally keep old SSR output can opt in to the exact
writer family they deployed:

```ts
import {
  UNVERSIONED_SNAPSHOT_MIGRATION_KEY,
  createLegacySnapshotMigration,
  installResumableLoader,
} from '@fictjs/runtime/loader'

installResumableLoader({
  snapshotMigrations: {
    // Pick only the dialect that matches the deployed v1 writer:
    1: createLegacySnapshotMigration('encoded-props'),

    // Optional for a known unversioned raw-props writer cohort:
    [UNVERSIONED_SNAPSHOT_MIGRATION_KEY]: createLegacySnapshotMigration('raw-props'),
  },
})
```

Historical writer families:

| Writer          | Key                                  | Format          |
| --------------- | ------------------------------------ | --------------- |
| v0.5-v0.8       | `UNVERSIONED_SNAPSHOT_MIGRATION_KEY` | `raw-props`     |
| v0.9-v0.21, v1  | `1`                                  | `raw-props`     |
| v0.22-v0.26, v1 | `1`                                  | `encoded-props` |

Do not select a format from payload shape. In v1, `{ "__t": "u" }` can be
either literal user data or the encoded form of `undefined`.

Snapshot rejection fallback is application-owned:

```ts
installResumableLoader({
  onSnapshotIssue: issue => reportSnapshotIssue(issue),
  onSnapshotRejected: async issue => {
    await mountClientRoot(issue)
  },
})
```

`onSnapshotIssue` only reports diagnostics. When `onSnapshotRejected` is
provided, the loader removes its listeners, prefetch work, snapshot observer,
and resumable state before invoking the callback once. The callback must mount
the CSR root. Async callback failure is reported as `snapshot_fallback_failed`.
Without this callback, rejected data stays unmerged and Fict does not mount CSR
automatically.

See the repository
[SSR / Resume Stability Contract](../../docs/ssr-resume-stability-contract.md)
for the complete compatibility and deployment policy.

## Reactive Getter Contract

Runtime value paths do not infer reactivity from function arity. A plain
zero-argument function is treated as a function value/callback. Use `reactive(fn)`
from `@fictjs/runtime/advanced` when manually authoring a low-level reactive
getter; compiler-generated getters are marked automatically.

## Dev/Prod Mode Contract (`__DEV__`)

Runtime dev-only branches use this precedence:

1. `__DEV__` (recommended, compile-time constant)
2. Fallback: `process.env.NODE_ENV !== 'production'` when `process` exists

For browser builds, define `__DEV__` explicitly in your bundler for predictable
DX and dead-code elimination:

- development: `__DEV__ = true`
- production: `__DEV__ = false`

## Multi-Document Contract (iframe / foreign `Document`)

`@fictjs/runtime` supports rendering into containers owned by non-global documents
(for example, elements from an iframe document). Runtime-created nodes, markers,
and fragments are created from the active `ownerDocument`.

Supported contract:

- `render()` into a container from another `Document`
- list/conditional/suspense marker creation in that container's `ownerDocument`
- node insertion paths that rely on runtime-created nodes

Important caveat:

- If user code manually returns nodes created from a different document and inserts
  them into another document tree, runtime may fall back to `adoptNode()` or
  `importNode()` during insertion/reordering. `importNode()` clones DOM nodes and
  does not preserve JS-side expando state or imperative listeners attached outside
  of Fict's binding flow.

Recommendation:

- Create DOM nodes using the target container's `ownerDocument` (or let Fict create
  nodes) when working across iframe/foreign-document boundaries.

## Runtime Stability Stress

Run stress scenarios for runtime correctness and reliability:

```bash
pnpm --dir packages/runtime test:stress
```

Long profile:

```bash
pnpm --dir packages/runtime test:stress:long
```

Root aliases are also available:

```bash
pnpm stress:runtime
pnpm stress:runtime:long
```

Environment knobs:

- `FICT_RUNTIME_SOAK_ITERS`
- `FICT_RUNTIME_CHURN_CYCLES`
- `FICT_RUNTIME_CHURN_LIST_SIZE`
- `FICT_RUNTIME_LEAK_ROUNDS`
- `FICT_RUNTIME_LEAK_EFFECTS_PER_ROUND`
- `FICT_RUNTIME_MAX_HEAP_GROWTH_BYTES`
- `FICT_RUNTIME_BACKPRESSURE_UPDATES`
- `FICT_RUNTIME_BACKPRESSURE_TIMEOUT_MS`
- `FICT_RUNTIME_MAX_DRAIN_LATENCY_MS`
