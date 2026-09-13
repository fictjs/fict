# Strict Guarantee Cookbook

`strictGuarantee` is enabled by default. It turns non-guaranteed reactivity
diagnostics into build errors so production code cannot silently fall back to
less precise updates.

Use this cookbook when a migrated component compiles in relaxed mode but fails
under the default profile.

## Recommended Workflow

1. Run the migration branch once with `strictGuarantee: false` outside
   production to inventory diagnostics.
2. Fix the source patterns instead of suppressing the diagnostics.
3. Re-enable `strictGuarantee: true`.
4. Add `FICT_STRICT_GUARANTEE=1` to CI so build steps cannot drift.

Do not ship `strictGuarantee: false`. Production compilation force-enables
strict guarantee even when an integration requests opt-out.

## Common Fixes

### Selector Sources And Callback Lifetimes

An official `createSelector` source runs synchronously in a computation owned by
the current root. It is a supported reactive callback, including named imports,
renamed imports, namespace members, and intact local aliases:

<!-- strict-example: selector-source -->

```tsx
import { $state, createSelector } from 'fict'

export function SelectionExample() {
  let selected = $state(1)
  const isSelected = createSelector(() => selected)
  return (
    <button class={isSelected(1) ? 'selected' : ''} onClick={() => (selected = 2)}>
      Select second
    </button>
  )
}
```

<!-- /strict-example -->

The equality callback must not capture additional reactive inputs. It runs when
the source changes or a key is read, so those captures would not have an independent
subscription. Include all changing inputs in the source and compare its arguments.

Import identity does not grant ownership of an async continuation. A reactive
capture in an `async` or generator callback remains a strict boundary, including
callbacks passed to `untrack`, `batch`, `startTransition`, or `createEffect`. For
detached work that needs only an initial primitive value, capture that value in a
synchronous `untrack` before scheduling the callback. An unrelated package or a
reassigned function with the same name does not inherit a Fict runtime contract.

### Prop Rest Or Native Spread Fallback

Native element rest spreads can hide which DOM props are reactive.

```tsx
// Before
function Input({ label, ...rest }) {
  return <input aria-label={label} {...rest} />
}

// After: keep the native prop surface explicit.
function Input(props) {
  return <input aria-label={props.label} value={props.value} disabled={props.disabled} />
}
```

When forwarding is intentional, isolate the forwarding boundary and use
`mergeProps` so the review surface is explicit.

### Dynamic Keys

Dynamic object access cannot always be narrowed at compile time.

```tsx
// Before
const value = settings[userInput]

// After: narrow the supported keys.
const key = userInput === 'compact' || userInput === 'theme' ? userInput : 'theme'
const value = settings[key]
```

For truly dynamic maps, use `$store` so runtime path tracking owns the
per-property subscription.

```tsx
const settings = $store({ compact: false, theme: 'light' })
const value = settings[userSelectedKey]
```

### Black-Box Function Escapes

Passing a reactive value to an arbitrary function does not establish a reactive
subscription. For an intentional one-time primitive value, put the call inside
the synchronous callback of Fict's `untrack`:

<!-- strict-example: primitive-snapshot -->

```tsx
import { $state, untrack } from 'fict'
import { externalFormat } from 'external'

export function SnapshotExample() {
  let count = $state(1)
  const result = untrack(() => externalFormat(count))
  return <button onClick={() => count++}>{result}</button>
}
```

<!-- /strict-example -->

The formatter runs once and receives the initial number. Clicking the button
changes `count`, while `result` keeps its snapshot value. You can also capture
`const captured = untrack(() => count)` and pass that primitive to a helper later.

The compiler must prove that the component-local state and its assignments keep
the captured value primitive. Object references, unknown writes, and accessors
whose writes belong to other modules retain their escape checks. `untrack` does
not clone objects, make nested mutations reactive, or transfer callback ownership.
For example, `untrack(() => externalHost(() => count))` still passes a live
closure and is diagnosed. An async callback is not a synchronous snapshot scope.

If the helper must stay reactive, use a Fict-aware API that owns the callback's
tracking and lifetime. Passing a getter to an unknown host can still produce
`FICT-R002` / `FICT-R005`; a getter alone does not prove the host's contract.

### Nested State Mutation

`$state` is shallow. Mutating a nested object can hide the write from the
dependency graph.

```tsx
// Before
let user = $state({ profile: { name: 'Ada' } })
user.profile.name = 'Grace'

// After: immutable update with $state.
user = { ...user, profile: { ...user.profile, name: 'Grace' } }
```

Use `$store` when direct deep mutation is the intended model.

```tsx
const user = $store({ profile: { name: 'Ada' } })
user.profile.name = 'Grace'
```

### Inline Components And Hooks

Component or hook definitions inside a component body can allocate reactive
state on every branch pass or obscure ownership.

```tsx
// Before
function Page() {
  function Row(props) {
    return <li>{props.item.title}</li>
  }
  return (
    <ul>
      {items.map(item => (
        <Row key={item.id} item={item} />
      ))}
    </ul>
  )
}

// After
function Row(props) {
  return <li>{props.item.title}</li>
}

function Page() {
  return (
    <ul>
      {items.map(item => (
        <Row key={item.id} item={item} />
      ))}
    </ul>
  )
}
```

### Branch Fallback And DOM Identity

Fict keeps supported `if-return`, `switch-return`, and JSX-only reads
fine-grained. When the compiler cannot prove fine-grained branch lowering, it
uses a tracked branch fallback that can remount the active branch.

If DOM identity matters, move long-lived DOM nodes outside the branch or split
the branch into keyed child components with tests that assert preservation.

## Suppression Rules

- `fict-ignore` and warning-level downgrades are not accepted for strict
  guarantee diagnostics.
- Use suppressions only in non-strict test fixtures that intentionally exercise
  fallback behavior.
- Add an inline comment near every `strictGuarantee: false` test config that
  explains why the suite is behavior-first rather than guarantee-first.
