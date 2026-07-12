# What is Fict?

Fict is a compiler-first, fine-grained UI framework for TypeScript and JavaScript. You write TSX with ordinary variables and expressions; the compiler turns reactive reads and writes into targeted DOM updates.

```tsx
import { $state, render } from 'fict'

function Counter() {
  let count = $state(0)
  const doubled = count * 2

  return (
    <button onClick={() => count++}>
      {count} × 2 = {doubled}
    </button>
  )
}

render(() => <Counter />, document.getElementById('app')!)
```

There is no setter function, dependency array, `.value`, or Fict-specific derived macro in this example. `doubled` is a normal JavaScript expression that the compiler recognizes as reactive.

## The execution model

A Fict component is not re-run after every state change. Its static setup runs once, while compiler-created reactive regions update only the DOM and computations that depend on the changed value.

This leads to three practical rules:

1. Put component-local state in top-level `$state(...)` declarations.
2. Express derived data as ordinary JavaScript. Use `$memo` only when you explicitly need a stable memo node.
3. Put external synchronization in `$effect`, and return cleanup work from the effect.

## Choosing a state API

| Need                               | API                         | Import          |
| ---------------------------------- | --------------------------- | --------------- |
| Component-local value              | `$state`                    | `fict`          |
| Derived component value            | Plain JavaScript expression | —               |
| Deep mutable shared object         | `$store`                    | `fict`          |
| Shared scalar or library primitive | `createSignal`              | `fict/advanced` |
| Subtree-scoped dependency          | Context                     | `fict/advanced` |
| Async cached data                  | `resource`                  | `fict/plus`     |

`$state` and `$effect` must pass through the Fict compiler. Calling either macro in uncompiled code throws a diagnostic instead of silently becoming non-reactive.

## Continue learning

- [Install Fict and build a counter](/guide/getting-started)
- [Understand the compiler-first model](/guide/fiction-ui)
- [Learn component state](/guide/state)
- [Learn automatic derived values](/guide/derived)
- [Browse the API map](/api/)

## Source of truth

The public entry-point contract lives in `packages/fict/src/index.ts`; compiler semantics are specified in `docs/compiler-spec.md` and `docs/reactivity-semantics.md`.
