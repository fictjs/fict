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

Passing reactive values to arbitrary functions is a snapshot unless the callee
is a known Fict-aware callback host.

```tsx
// Before
const result = externalFormat(count)

// After: make snapshot semantics explicit.
const result = untrack(() => externalFormat(count))
```

If the helper must stay reactive, wrap the reactive read in a Fict-aware API
that calls the callback under a tracked computation.

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
