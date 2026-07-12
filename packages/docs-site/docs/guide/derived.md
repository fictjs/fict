---
type: feature-spec
title: Derived values
description: Express reactive derivations with plain JavaScript and use explicit memos only when needed.
owner: NEEDS_OWNER
status: proposed
tags: [guide, reactivity, memo]
---

# Derived Values

Fict derives values automatically. If an expression reads reactive state or props, the compiler keeps its result current.

```tsx
function Cart({ taxRate }) {
  let price = $state(20)
  let quantity = $state(2)

  const subtotal = price * quantity
  const tax = subtotal * taxRate
  const total = subtotal + tax

  return <output>Total: {total}</output>
}
```

There is no Fict `$derived` macro. Use ordinary `const` declarations, function calls that the compiler can safely analyze, template strings, destructuring, and native control flow.

## Automatic memoization

Reactive bindings are memoized by default. The compiler builds the dependency graph and may inline a single-use derivation as an optimization without changing observable behavior.

```tsx
let firstName = $state('Ada')
let lastName = $state('Lovelace')

const fullName = `${firstName} ${lastName}`
const greeting = `Hello, ${fullName}`
```

When either state value changes, Fict recomputes only the dependent chain and bindings.

## Explicit `$memo`

Use `$memo` when code needs an accessor, when tooling should expose a concrete memo node, or when the file opts out of automatic memoization.

```tsx
import { $memo } from 'fict'

function Totals({ items }) {
  const total = $memo(() => items.reduce((sum, item) => sum + item.price, 0))

  return <output>{total()}</output>
}
```

`$memo` is an alias of `createMemo`; both return a read-only accessor.

## Opting out

The `"use no memo"` directive disables automatic memoization for a file or function. Plain derived bindings then behave as getters/expressions, and `$memo` opts selected computations back into caching.

```tsx
'use no memo'

import { $memo } from 'fict'

function Report({ rows }) {
  const count = rows.length
  const expensive = $memo(() => rows.map(row => row.label).join(', '))
  return (
    <p>
      {count}: {expensive()}
    </p>
  )
}
```

Most application code should keep the default behavior.

## Prefer derivations to effects

Do not copy one reactive value into another with an effect:

```tsx
// Avoid: creates an unnecessary synchronized state write.
let total = $state(0)
$effect(() => {
  total = price * quantity
})

// Prefer: dependency is explicit and read-only.
const total = price * quantity
```

Effects are for synchronization with systems outside the reactive graph.

## Verification

- Semantic contract: `docs/reactivity-semantics.md`.
- Compiler rules: `docs/compiler-spec.md`.
- Runtime memo: `packages/runtime/src/memo.ts`.
- Repository check: `pnpm --filter @fictjs/compiler test && pnpm --filter fict-docs-site build`.
