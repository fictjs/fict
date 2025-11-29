# Fict

> Reactive UI with zero boilerplate.

Fict is a tiny UI library where you write plain JavaScript and the compiler figures out the reactivity.

- `$state` for reactive data
- `$effect` for side effects
- Everything else is automatic

No `useMemo`. No dependency arrays. No `.value`. Just JavaScript.

```jsx
function Counter() {
  let count = $state(0)
  const doubled = count * 2  // auto-derived
  return <button onClick={() => count++}>{doubled}
}
```

**Why "Fict"?** Because UI is fiction — a narrative layer over your
real data. Fict makes that fiction explicit, testable, and trivial to write.
