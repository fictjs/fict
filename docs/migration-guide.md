# Migration Guide

This guide helps teams move code from React, Vue, Svelte, or Solid to Fict.
It is not a compatibility promise: Fict keeps JSX/TSX ergonomics, but it
compiles to a fine-grained graph with fail-closed reactivity guarantees.

## Migration Strategy

1. Start with leaf components and isolated routes.
2. Keep behavior tests around the component before changing reactivity.
3. Run the first compile with `strictGuarantee: false` only in a
   non-production migration branch to collect diagnostics.
4. Fix diagnostics with the patterns below.
5. Enable default `strictGuarantee: true` before merging.
6. Add `FICT_STRICT_GUARANTEE=1` to CI build steps so later config drift fails.

Use `strictGuarantee: false` as an inventory tool, not as a long-term app
profile. Production builds force strict guarantee back on.

## Compiler Backend Migration

The OXC-native compiler is available as an explicit beta while Vite keeps the
legacy backend as its default. Select one backend for the entire build:

```ts
import fict from '@fictjs/vite-plugin'

export default {
  plugins: [fict({ backend: 'rust' })],
}
```

Use `FICT_COMPILER_BACKEND=rust` for an application-wide CI trial and
`FICT_COMPILER_BACKEND=legacy` for operational rollback. An explicit plugin
option takes precedence over the environment. Do not choose the backend from a
per-file callback or retry a failed Rust file through Babel.

With `backend: 'rust'`, the Vite runtime graph uses the native compiler and the
Babel-free compiler graph host. Babel packages can remain installed during the
compatibility window, but neither they nor `@fictjs/compiler/legacy` are
evaluated by Rust compilation, including cache-key computation and structured
handler consumption. `legacy` and `shadow` load that compatibility runtime only
after their whole-build mode has been selected.

Before changing an application, run shadow mode. It returns legacy output but
creates a privacy-safe comparison artifact:

```ts
fict({
  backend: 'shadow',
  shadow: {
    reportPath: '.fict-cache/compiler-shadow.json',
    allowlistPath: '.github/compiler-shadow-allowlist.json',
    failOnDifference: true,
  },
})
```

Copy and review the repository allowlist instead of adding a wildcard for a
semantic category. Output-printer and helper-composition differences may be
structural; diagnostics, metadata, semantic events, maps, and artifacts remain
blocking.

Webpack users should migrate from `@fictjs/babel-preset` to the native
`@fictjs/webpack-plugin` loader. Direct compiler integrations can import the
serializable `transformSync`, `transform`, `scan`, or `analyze` facade from
`@fictjs/compiler/native`; the facade lazily selects and reuses the validated
platform binding. Custom Babel pipelines that still
need sibling plugins should run native Fict compilation as a separate first
stage and compose source maps explicitly.

`@fictjs/babel-preset` remains a tested whole-build legacy rollback during the
compatibility window, but emits one development-time deprecation warning per
process. Do not suppress that warning in committed configuration; migrate to an
official Vite, Webpack, or direct native integration.

Preview `resumable: true` is available with the Rust beta through compiler-owned
structured handler artifacts. It remains explicit and Preview; native support
does not graduate it or make it a Core default.

See the [Rust compiler rollout](features/rust-compiler-rollout/rollout.md) and
[rollback runbook](operations/runbooks/compiler-backend-rollback.md) for the
candidate, cache, and review gates.

## Concept Map

| Source concept           | Fict equivalent                                    |
| ------------------------ | -------------------------------------------------- |
| React `useState`         | `let value = $state(initial)`                      |
| React `useMemo`          | Plain derived `const value = expression`           |
| React `useEffect`        | `$effect`, `onMount`, `onCleanup`, or `onDestroy`  |
| React context            | `createContext` / `useContext`                     |
| Vue `ref`                | `$state` for local values                          |
| Vue `reactive`           | `$store` for deep shared objects                   |
| Vue `computed`           | Plain derived `const value = expression`           |
| Vue `watchEffect`        | `$effect`                                          |
| Svelte `$state`          | Fict `$state`                                      |
| Svelte `$derived`        | Plain derived `const value = expression`           |
| Svelte `{#if}`           | Native `if` / ternary in TSX                       |
| Solid `createSignal`     | `$state` in components, `createSignal` in advanced |
| Solid `createMemo`       | Plain derived `const value = expression`           |
| Solid `<Show>` / `<For>` | Native `if` / `map` with stable keys               |

## React

React components re-run; Fict components run once and update bindings,
memos, effects, or tracked branches. Move render-time derivations out of
manual hooks and let the compiler infer them.

```tsx
// React
function Counter() {
  const [count, setCount] = useState(0)
  const doubled = useMemo(() => count * 2, [count])
  return <button onClick={() => setCount(count + 1)}>{doubled}</button>
}

// Fict
function Counter() {
  let count = $state(0)
  const doubled = count * 2
  return <button onClick={() => count++}>{doubled}</button>
}
```

### Effects

Use `$effect` for reactive effects. Use `onMount` for one-time setup and
`onCleanup` inside `$effect` when the cleanup must re-run with the effect.

```tsx
// React
useEffect(() => {
  const stop = subscribe(id, value => setValue(value))
  return stop
}, [id])

// Fict
$effect(() => {
  const stop = subscribe(id, value => {
    latest = value
  })
  onCleanup(stop)
})
```

### Props And Rest Spreads

Simple prop destructuring is supported. Rest props and native element spreads
can lose per-prop guarantees, so prefer explicit props or `mergeProps`.

```tsx
// Risky during migration: rest spread can hide dynamic native props.
function Button({ variant, ...rest }) {
  return <button {...rest} class={`btn ${variant}`} />
}

// Prefer explicit props, or mergeProps when forwarding is intentional.
function Button(props) {
  const merged = mergeProps({ type: 'button' }, props)
  return <button type={merged.type} class={`btn ${merged.variant}`} />
}
```

## Vue

Use `$state` for component-local values and `$store` for deep shared objects.
Fict does not use `.value`.

```tsx
// Vue
const count = ref(0)
const doubled = computed(() => count.value * 2)
count.value++

// Fict
let count = $state(0)
const doubled = count * 2
count++
```

For `reactive` objects, use `$store` and mutate properties directly.

```tsx
const user = $store({ profile: { name: 'Ada' } })
user.profile.name = 'Grace'
```

## Svelte

Fict's `$state` is also a compiler macro, but derived values do not require
`$derived`.

```tsx
// Svelte
let count = $state(0)
let doubled = $derived(count * 2)

// Fict
let count = $state(0)
const doubled = count * 2
```

Svelte blocks become normal TSX control flow. Keep list keys stable.

```tsx
return (
  <ul>
    {todos.map(todo => (
      <li key={todo.id}>{todo.title}</li>
    ))}
  </ul>
)
```

## Solid

Most Solid reactive primitives map directly, but Fict removes getter calls in
component code.

```tsx
// Solid
const [count, setCount] = createSignal(0)
const doubled = createMemo(() => count() * 2)
return <button onClick={() => setCount(count() + 1)}>{doubled()}</button>

// Fict
let count = $state(0)
const doubled = count * 2
return <button onClick={() => count++}>{doubled}</button>
```

Use `createSignal` from `fict/advanced` only for library-level or module-level
escape hatches. In application components, prefer `$state` and `$store`.

## Patterns That Need Rewrites

| Pattern                              | Rewrite                                                     |
| ------------------------------------ | ----------------------------------------------------------- |
| Mutating nested `$state` objects     | Reassign immutably, or use `$store` for direct deep writes  |
| Dynamic object keys from user input  | Narrow keys, use `$store`, or isolate in an explicit helper |
| Passing state into black-box helpers | Use `untrack` for snapshots or a Fict-aware callback API    |
| Native element rest spreads          | Prefer explicit props or `mergeProps`                       |
| Component definitions inside render  | Move components to module scope or a stable factory         |
| List rendering without keys          | Add stable keys from data, not array indexes                |

## Migration Exit Criteria

- No production build opts out of `strictGuarantee`.
- CI sets `FICT_STRICT_GUARANTEE=1` for build/typecheck gates.
- All `fict-ignore` suppressions are removed from strict guarantee paths.
- Store usage is either `$state` with immutable updates or `$store` with direct
  deep mutation; do not mix both models for the same object.
- Branch fallback behavior is covered by tests where DOM identity matters.
