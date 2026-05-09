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
