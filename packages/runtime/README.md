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
