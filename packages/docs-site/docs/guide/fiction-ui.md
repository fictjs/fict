---
type: feature-spec
title: Fiction UI philosophy
description: The compiler-first execution and reactivity model behind Fict applications.
owner: NEEDS_OWNER
status: proposed
tags: [guide, compiler, reactivity]
---

# Fiction UI Philosophy

Fict treats the component source as a description from which the compiler builds a reactive program. The goal is to keep authoring close to ordinary JavaScript while making update ownership explicit and disposable at runtime.

## Components set up once

```tsx
function Profile({ firstName, lastName }) {
  console.log('setup')
  const fullName = `${firstName} ${lastName}`

  return <h1>{fullName}</h1>
}
```

The static setup executes once. Reactive prop reads and `fullName` are lowered to accessors, so the text binding can update without re-running the entire component.

This differs from a virtual-DOM model that re-executes components to discover changes. Fict instead maintains a fine-grained graph of state, derived values, effects, and DOM bindings.

## JavaScript expresses derivation

```tsx
let price = $state(20)
let quantity = $state(2)

const subtotal = price * quantity
const total = subtotal * 1.2
```

Both assignments are automatically derived. Fict has no `$derived` API. The compiler memoizes reactive bindings by default and may inline single-use values when that does not change behavior. Use `$memo(() => expression)` when tooling or library code needs a concrete memo accessor.

## Native control flow remains native

```tsx
function Result({ user }) {
  if (!user) return <p>Signed out</p>
  return <p>Welcome, {user.name}</p>
}
```

Supported `if`, `switch`, conditional, and keyed list shapes become reactive branches. Fict does not require special `<Show>` or `<For>` components for ordinary control flow.

## The compiler fails closed

Some JavaScript boundaries cannot safely preserve implicit reactivity—for example, sending a reactive value to an unknown callback host. With strict guarantees enabled, the compiler reports the boundary instead of guessing and risking stale behavior.

Typical remedies are to:

- keep computation inside a compiler-visible expression;
- pass an explicit getter when the consumer understands reactivity;
- pass an intentional snapshot when only the current value is needed;
- use an advanced API such as `reactive` or `untrack` when building an integration.

## Ownership drives cleanup

Component state, effects, event bindings, resources, and lifecycle callbacks belong to a root. Removing that root disposes its subscriptions and cleanup functions. This is why `$state` is component-scoped and why shared module state uses `$store`, `createSignal`, or Context instead.

## Practical consequence

Write the simplest expression that states the dependency. Reach for effects only to synchronize with something outside the reactive graph, such as the DOM, a timer, storage, or a network transport.

## Verification

- Semantic contract: `docs/reactivity-semantics.md`.
- Compiler invariants: `docs/compiler-spec.md` and `docs/compiler-pass-invariants.md`.
- Runtime ownership: `packages/runtime/src/lifecycle.ts`.
- Repository check: `pnpm --filter @fictjs/compiler test && pnpm --filter fict-docs-site build`.
