# Diagnostic Codes Reference

This document provides detailed explanations for Fict compiler diagnostics. Each entry includes:

- **Why** — What triggered this diagnostic
- **Impact** — How it affects runtime behavior
- **Fix** — Recommended solutions

Codes surface at compile time and via `@fictjs/eslint-plugin` where applicable.

---

## Props (FICT-P\*)

### FICT-P001: Props destructuring fallback

**Severity:** Warning

**Why:** Destructuring props with complex patterns (nested destructuring, default values, computed properties) requires runtime handling instead of compile-time optimization.

**Impact:** Reactivity is preserved, but with slight runtime overhead. The compiler falls back to runtime prop tracking instead of static analysis.

**Fix:** Use simple destructuring patterns:

```js
// Preferred
const { name, count } = props

// Avoid (triggers fallback)
const {
  user: { name },
} = props
const { count = 0 } = props
```

### FICT-P002: Array rest in props destructuring

**Severity:** Warning

**Why:** Rest patterns in array destructuring cannot be statically analyzed for reactivity.

**Impact:** The rest element may not track updates correctly.

**Fix:** Destructure specific indices or use explicit array access.

### FICT-P003: Computed property in props

**Severity:** Warning

**Why:** Dynamic property names (`props[key]`) cannot be statically tracked.

**Impact:** Coarse-grained tracking — updates to any property trigger re-evaluation.

**Fix:** Use static property access where possible:

```js
// Fine-grained
const value = props.name

// Coarse-grained (triggers P003)
const key = 'name'
const value = props[key]
```

---

## State (FICT-S\*)

### FICT-S001: State variable mutation

**Severity:** Error

**Why:** Direct mutation of state internals bypasses the reactive system.

**Impact:** Changes will not trigger updates. UI will be stale.

**Fix:** Use assignment to trigger updates:

```js
// Wrong — mutation
let items = $state([1, 2, 3])
items.push(4) // FICT-S001

// Correct — assignment
items = [...items, 4]
```

### FICT-S002: State escapes current scope

**Severity:** Warning

**Why:** A `$state` variable is being passed to or returned from a context where the compiler cannot guarantee proper tracking.

**Impact:** Updates may not propagate correctly to consumers outside the current scope.

**Fix:**

- Keep state within component scope
- Pass explicit getter functions that read state instead of state itself
- Use `$store` from `fict/plus` for shared global state

```js
// Risky — state escapes
export const count = $state(0) // FICT-S002

// Better — export accessors
let count = $state(0)
export const getCount = () => count
export const setCount = v => (count = v)

// Or use $store for shared global state
import { $store } from 'fict/plus'
export const appState = $store({ count: 0 })
```

---

## Effects (FICT-E\*)

### FICT-E001: Effect has no reactive dependencies

**Severity:** Warning

**Why:** An `$effect` body contains no reactive reads. It will only run once on mount.

**Impact:** The effect never re-runs, which is usually unintentional.

**Fix:** Ensure the effect reads at least one reactive value, or use `onMount` if one-time execution is intended.

```js
// Triggers FICT-E001
$effect(() => {
  console.log('Hello') // no reactive reads
})

// Correct
$effect(() => {
  console.log('Count is', count) // reactive read
})
```

### FICT-E002: Effect captures reactive value

**Severity:** Info

**Why:** An effect callback captures a reactive value from outer scope.

**Impact:** This is usually correct — the effect will re-run when the captured value changes. This diagnostic is informational.

### FICT-E003: Effect cleanup tracking failed

**Severity:** Warning

**Why:** The compiler could not determine if the effect properly cleans up subscriptions or side effects.

**Impact:** Potential memory leaks or stale subscriptions.

**Fix:** Return a cleanup function from the effect:

```js
$effect(() => {
  const subscription = eventSource.subscribe(handler)
  return () => subscription.unsubscribe() // cleanup
})
```

---

## Memo (FICT-M\*)

### FICT-M001: Memo has no reactive dependencies

**Severity:** Warning

**Why:** A memoized value (`$memo` or derived) doesn't depend on any reactive sources.

**Impact:** The memo is effectively a constant. This may indicate a logic error.

**Fix:** Verify the computation should depend on reactive values, or convert to a plain constant.

### FICT-M002: Unnecessary memo

**Severity:** Hint

**Why:** A value is wrapped in `$memo` but Fict would automatically memoize it based on usage.

**Impact:** No functional impact, but adds unnecessary code.

**Fix:** Remove explicit `$memo` and let the compiler handle memoization.

### FICT-M003: Memo contains side effects

**Severity:** Error

**Why:** A memoized computation performs side effects (DOM manipulation, API calls, logging, etc.).

**Impact:** Memos can be re-evaluated at any time when dependencies change. Side effects in memos lead to unpredictable behavior.

**Fix:** Move side effects to `$effect`:

```js
// Wrong
const data = $memo(() => {
  console.log('computing') // FICT-M003
  return count * 2
})

// Correct
const data = $memo(() => count * 2)
$effect(() => console.log('data changed:', data))
```

---

## Control Flow (FICT-C\*)

### FICT-C001: Conditional hooks

**Severity:** Error

**Why:** `$state`, `$effect`, or `$memo` appears inside a conditional block.

**Impact:** Reactive primitives must be created unconditionally to maintain consistent hook ordering.

**Fix:** Move declarations to top level:

```js
// Wrong
if (condition) {
  let x = $state(0) // FICT-C001
}

// Correct
let x = $state(0)
if (condition) {
  // use x
}
```

### FICT-C002: Hooks in loop

**Severity:** Error

**Why:** `$state`, `$effect`, or `$memo` appears inside a loop.

**Impact:** Creates multiple reactive primitives with unpredictable lifecycle.

**Fix:** Declare outside the loop or use a data structure:

```js
// Wrong
for (let i = 0; i < n; i++) {
  let item = $state(i) // FICT-C002
}

// Correct
let items = $state(Array.from({ length: n }, (_, i) => i))
```

### FICT-C003: Nested component definitions

**Severity:** Warning

**Why:** A component function is defined inside another component.

**Impact:** The inner component is recreated on every parent render, losing all state.

**Fix:** Move component definitions to module level:

```js
// Wrong
function Parent() {
  function Child() { ... }  // FICT-C003
  return <Child />
}

// Correct
function Child() { ... }
function Parent() {
  return <Child />
}
```

### FICT-C004: Component missing return

**Severity:** Warning

**Why:** A component function has code paths that don't return JSX.

**Impact:** Renders `undefined`, which may cause runtime errors.

**Fix:** Ensure all code paths return valid JSX or `null`.

---

## JSX (FICT-J\*)

### FICT-J001: Dynamic key expression

**Severity:** Warning

**Why:** A list item's `key` prop uses a dynamic expression that may not be stable.

**Impact:** Inefficient reconciliation, potential state loss during reordering.

**Fix:** Use stable, unique identifiers:

```js
// Risky
items.map((item, index) => <Li key={index} />) // FICT-J001

// Correct
items.map(item => <Li key={item.id} />)
```

### FICT-J002: Missing key in list

**Severity:** Warning

**Why:** Elements returned from `.map()` lack `key` props.

**Impact:** Fict cannot efficiently reconcile list updates. May cause incorrect state association.

**Fix:** Add unique `key` props:

```js
items.map(item => <Li key={item.id}>{item.name}</Li>)
```

### FICT-J003: Spread props may hide reactivity

**Severity:** Info

**Why:** Spread props (`{...obj}`) make it harder to track which specific props are reactive.

**Impact:** May result in coarser update granularity.

**Fix:** Prefer explicit props when reactivity granularity matters:

```js
// Less optimal
<Component {...props} />

// More explicit
<Component name={props.name} count={props.count} />
```

---

## Regions/Scopes (FICT-R\*)

### FICT-R001: Region boundary crossed

**Severity:** Warning

**Why:** A reactive value is used across region boundaries in a way the compiler cannot optimize.

**Impact:** Reactivity preserved but may use less efficient update path.

### FICT-R002: Scope escape detected

**Severity:** Warning

**Why:** A reactive binding escapes its declaration scope.

**Impact:** Similar to FICT-S002. Updates may not propagate correctly.

### FICT-R003: Non-memoizable expression

**Severity:** Info

**Why:** An expression cannot be memoized due to its structure (e.g., contains function calls with unknown purity).

**Impact:** Expression re-evaluated on every reactive update.

### FICT-R004: Reactive primitive in control flow

**Severity:** Warning

**Why:** A reactive primitive (`$state`, `$effect`, `createMemo`, `createSelector`) is created inside non-JSX control flow without a scope boundary.

**Impact:** May cause memory leaks or unexpected lifecycle behavior.

**Fix:** Ensure reactive primitives are created at component top level.

### FICT-R005: Closure capture issue

**Severity:** Warning

**Why:** A closure captures a reactive value in a way that may cause stale reads.

**Impact:** This is rare in Fict due to automatic getter conversion. Usually indicates an edge case.

---

## Performance (FICT-X\*)

### FICT-X001: Object literal recreated

**Severity:** Hint

**Why:** An object literal in JSX props is recreated on every update.

**Impact:** May cause unnecessary child re-renders if child uses reference equality checks.

**Fix:** Extract to a constant or use `$memo`:

```js
// Recreated every time
<Component style={{ color: 'red' }} />

// Stable reference
const style = { color: 'red' }
<Component style={style} />
```

### FICT-X002: Array literal recreated

**Severity:** Hint

**Why:** Similar to FICT-X001 for arrays.

### FICT-X003: Inline function in JSX

**Severity:** Hint

**Why:** An inline arrow function is passed as a prop.

**Impact:** In Fict, this is usually fine due to stable handler references. This hint is for cases where reference stability matters (e.g., memoized children).

**Fix:** If needed, extract to a named function:

```js
// Usually fine in Fict
<Button onClick={() => count++} />

// Extract if child uses reference equality
const handleClick = () => count++
<MemoizedButton onClick={handleClick} />
```

---

## Notes

- Compiler emits additional internal codes during transformation that are not exposed as lint rules.
- Keep lint and compiler versions in sync to ensure consistent warning surface in editor and build logs.
- Some diagnostics can be suppressed with directive comments (feature planned).

## See Also

- [reactivity-semantics.md](./reactivity-semantics.md) — Reactive behavior rules
- [compiler-spec.md](./compiler-spec.md) — Compiler transformation details
