---
type: contract
title: $state
description: Public compiler-macro contract for component-owned reactive state.
owner: NEEDS_OWNER
status: proposed
tags: [api, state, compiler]
---

# `$state`

Declares a mutable component-local value whose reads and writes are transformed into fine-grained reactive operations.

```ts
function $state<T>(initialValue: T): T
```

```tsx
import { $state } from 'fict'

function Counter() {
  let count = $state(0)
  return <button onClick={() => count++}>{count}</button>
}
```

## Parameters

- `initialValue`: the initial value for this component instance.

## Returns

In source, `$state` appears to return `T`, so normal JavaScript assignment syntax remains type-safe. The compiler replaces the call and all supported reads/writes with an owned runtime signal.

## Placement contract

`$state` is valid only at the immediate top level of:

- a component function; or
- a hook-style helper named `useX`, invoked at the top level of a component or another hook.

Module-level, conditional, looped, or nested-callback declarations are compile errors. For shared module state, use `$store` or `createSignal`.

## Update contract

Assignments, compound assignments, and increment/decrement operators publish updates:

```tsx
count = 4
count += 2
count++
```

Closures read the current state at invocation time after compilation.

Objects and arrays are stored as single values. Replace their reference to publish nested changes:

```tsx
let settings = $state({ theme: 'light' })
settings = { ...settings, theme: 'dark' }
```

Use [`$store`](/api/store) for transparent deep mutation.

## Built-in receiver proof

Strict mode permits a known read-only method only when it can prove the shallow state value's
built-in receiver family. Literal and global constructor/factory syntax can provide that proof. A
direct built-in type argument is also an explicit, caller-owned contract:

```tsx
const rows = $state<number[]>(loadRows())
const labels = rows.map(row => String(row))
```

The compiler does not add a runtime `Array.isArray` check. If `loadRows()` does not actually return
an array, the resulting JavaScript failure is outside `strictGuarantee`.

The compiler does not infer the same contract from erased or indirect TypeScript syntax:

```tsx
type Rows = number[]

$state(value as number[]) // assertion is not receiver proof
let rows: number[] = $state(value) // binding annotation is not receiver proof
$state<Rows>(value) // local type alias is not receiver proof
```

Use a direct built-in family such as `$state<number[]>`, validate an unknown value before creating
state, or initialize from recognizable runtime syntax. Shadowed built-in names are never trusted.

## Failure behavior

The exported JavaScript function is a diagnostic stub and always throws if called. Reaching it means the source did not pass through a compatible Fict compiler integration.

## Verification

- Public declaration: `packages/fict/src/index.ts`.
- Compiler placement and lowering: `docs/compiler-spec.md`.
- Diagnostic stub: `packages/fict/src/macro-diagnostics.ts`.
- Repository check: `pnpm --filter fict test && pnpm --filter @fictjs/compiler test`.
