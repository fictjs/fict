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
