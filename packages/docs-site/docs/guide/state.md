---
type: feature-spec
title: Component state
description: Declare, update, and scope compiler-managed component state with $state.
owner: NEEDS_OWNER
status: proposed
tags: [guide, reactivity, state]
---

# Component State

`$state(initialValue)` declares component-local reactive state. It is a compiler macro: source code uses a normal variable, while compiled code stores the value in a signal owned by the component.

```tsx
function Counter() {
  let count = $state(0)

  return <button onClick={() => count++}>Clicked {count} times</button>
}
```

## Placement rules

Declare `$state` at the immediate top level of a component or a hook-style helper whose name matches `^use[A-Z0-9_]` (for example, `useToggle`, `use2FA`, or `use_toggle`). Names such as `useful` are ordinary helpers, not hooks.

```tsx
function useToggle(initial: boolean) {
  let enabled = $state(initial)
  return {
    enabled: () => enabled,
    toggle: () => (enabled = !enabled),
  }
}

function Panel() {
  const toggle = useToggle(false)
  return <button onClick={toggle.toggle}>{toggle.enabled() ? 'Hide' : 'Show'}</button>
}
```

Do not declare `$state`:

- at module scope;
- inside a loop or conditional;
- inside an event handler or other nested callback;
- in an ordinary helper that the compiler cannot associate with a component.

These placements are compilation errors because state would not have deterministic ownership.

## Updating values

Assignment and JavaScript mutation operators become signal writes:

```tsx
let count = $state(0)

count = 10
count += 2
count++
```

Closures created in the component read the current value when invoked, so event handlers do not capture a stale state snapshot.

## Objects and arrays are shallow

`$state` tracks the whole stored value. Replace objects and arrays when changing them:

```tsx
let user = $state({ name: 'Ada', active: false })
let tags = $state<string[]>([])

const activate = () => {
  user = { ...user, active: true }
}

const addTag = (tag: string) => {
  tags = [...tags, tag]
}
```

For direct nested mutation and property-level tracking, use [`$store`](/api/store):

```tsx
const user = $store({ profile: { name: 'Ada' } })
user.profile.name = 'Grace'
```

## State or store?

| Requirement                                | Use                                 |
| ------------------------------------------ | ----------------------------------- |
| Local primitive or replace-by-value object | `$state`                            |
| Deep direct mutation                       | `$store`                            |
| Shared module-level object                 | `$store`                            |
| Shared module-level scalar                 | `createSignal` from `fict/advanced` |

See the complete [`$state` API contract](/api/state).

## Verification

- Public macro: `packages/fict/src/index.ts`.
- Placement rules: `docs/compiler-spec.md`.
- Compiler coverage: `packages/compiler/test` and `packages/fict/test/compiler-integration.test.ts`.
- Repository check: `pnpm --filter fict test && pnpm --filter fict-docs-site build`.
