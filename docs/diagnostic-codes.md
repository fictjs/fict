# Diagnostic Codes Reference

This document provides detailed explanations for Fict compiler diagnostics. Each entry includes:

- **Why** — What triggered this diagnostic
- **Impact** — How it affects runtime behavior
- **Fix** — Recommended solutions

Codes surface at compile time and via `@fictjs/eslint-plugin` where applicable.
Some diagnostics are compiler-only, some are lint-only, and a few are reserved for future checks.

---

## Props (FICT-P\*)

### FICT-P001: Props destructuring fallback

**Severity:** Error (default)

**Why:** Destructuring props with unsupported patterns triggers a fallback.

**Impact:** Reactivity may be lost — the compiler falls back to plain destructuring (snapshot) for those patterns.

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

**Severity:** Error (default)

**Why:** Rest patterns in array destructuring cannot be statically analyzed for reactivity.

**Impact:** The compiler falls back to plain destructuring; reactivity for those bindings is not preserved.

**Fix:** Destructure specific indices or use explicit array access.

### FICT-P003: Computed property in props

**Severity:** Warning

**Why:** Dynamic property names in destructuring (`{ [key]: value }`) cannot be statically tracked.

**Impact:** The compiler falls back to plain destructuring; reactivity for that binding is not preserved.

**Fix:** Use static property access where possible:

```js
// Fine-grained
const value = props.name

// Computed destructuring (triggers P003)
const key = 'name'
const { [key]: value } = props
```

### FICT-P004: Nested props destructuring fallback

**Severity:** Warning

**Why:** Nested destructuring patterns require conservative handling.

**Impact:** Some nested patterns may fall back to non-reactive bindings. Prefer direct prop access or `prop(...)` for nested values.

**Fix:** Access nested props directly or use `prop`:

```js
// Prefer
const name = props.user.name

// Or
const name = prop(() => props.user.name)
```

### FICT-P005: Dynamic props spread

**Severity:** Warning

**Why:** Spreading a dynamic props object makes it hard to preserve reactivity for individual keys.

**Impact:** Updates may be coarser than expected.

**Fix:** Use explicit props or `mergeProps(() => source)` for dynamic shapes.

---

## State (FICT-S\*)

### FICT-S001: State variable mutation outside component scope

**Severity:** Error

**Why:** A `$state` variable is mutated outside the component/hook scope where it was declared.

**Impact:** Can cause lifecycle leaks or updates after unmount; reactive tracking may be invalid.

**Fix:** Keep mutations inside the declaring component/hook scope, or expose a setter:

```js
// Wrong — mutation outside component scope
let count
function Counter() {
  count = $state(0)
  return <button onClick={() => count++}>Inc</button>
}
export const inc = () => count++ // FICT-S001

// Better — keep mutation inside the component
function CounterSafe() {
  let count = $state(0)
  const inc = () => count++
  return <button onClick={inc}>Inc</button>
}
```

### FICT-S002: State escapes current scope

**Severity:** Warning

**Why:** A `$state` variable is passed to an arbitrary function, which captures a snapshot value.

**Impact:** Updates may not propagate correctly to consumers outside the current scope.

**Fix:**

- Pass explicit getter functions that read state instead of state itself
- Use `$store` from `fict` for shared global state

```js
// Risky — passes a snapshot
let count = $state(0)
someFn(count) // FICT-S002

// Better — pass getter
someFn(() => count)

// Or use $store for shared global state
import { $store } from 'fict'
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
  console.log(`Count is ${count}`) // reactive read
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

**Severity:** Info

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
$effect(() => console.log(`data changed: ${data}`))
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

**Severity:** Info

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

**Severity:** Info

**Why:** A reactive value is used across region boundaries in a way the compiler cannot optimize.

**Impact:** Reactivity preserved but may use less efficient update path.

### FICT-R002: Scope escape detected

**Severity:** Warning

**Why:** A reactive binding escapes its declaration scope.

**Impact:** Similar to FICT-S002. Updates may not propagate correctly.

### FICT-R003: Control-flow fallback lowering

**Severity:** Info

**Why:** Reactive `if`/`switch` return lowering was skipped for a branch shape the compiler
cannot safely lower into fine-grained branch bindings.

**Impact:** Branch structure may rely on a fallback path instead of strict fine-grained lowering.
Reactivity is preserved, but updates can be coarser than expected.

**Fix:** Refactor to supported return-branch control flow, or keep fallback behavior and
monitor/update performance with tests.

### FICT-R004: Reactive primitive in control flow

**Severity:** Error (default)

**Why:** A reactive primitive (`$state`, `$effect`, `createMemo`, `createSelector`) is created inside non-JSX control flow without a scope boundary.

**Impact:** May cause memory leaks or unexpected lifecycle behavior.

**Fix:** Ensure reactive primitives are created at component top level or wrap them with explicit scope management (`createScope`/`runInScope`).

**Downgrade (optional):** If your project needs transitional behavior, set compiler `warningLevels` to override:

```ts
warningLevels: {
  'FICT-R004': 'warn',
}
```

### FICT-R005: Closure capture issue

**Severity:** Warning

**Why:** A closure that captures reactive values escapes through an unknown callback boundary.

**Impact:** Dependency boundaries may become implicit and harder to reason about.
Non-escaping callbacks (for common iterator patterns like `map`/`filter`/`forEach`) are not flagged.

### FICT-R006: Reactive control-flow re-execution

**Severity:** Info

**Why:** Reactive values are read in control-flow predicates in a way that forces region or
branch re-execution.

**Impact:** Reactivity remains correct, but updates may execute broader code paths than pure
expression-level branching.

**Fix:** Prefer expression-only branching in JSX (`cond ? <A/> : <B/>`, logical expressions)
when you need tighter update granularity.

**Strict mode:** Set compiler `strictReactivity: true` to treat `FICT-R003` and
`FICT-R006` as build errors by default. You can still override per code with `warningLevels`.
`strictGuarantee` is enabled by default for fail-closed behavior where non-guaranteed reactivity
diagnostics cannot be suppressed or downgraded. Set `strictGuarantee: false` only when
intentionally opting out.
Set `FICT_STRICT_GUARANTEE=1` in CI to force-enable strict mode globally.
For the overall guarantee/fallback/unsupported map, see `docs/reactivity-guarantee-matrix.md`.

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

## Misc (Legacy / Generic)

These warnings are emitted by the compiler but are not part of the numbered FICT-\* catalog.

### FICT-M: Direct mutation of nested `$state`

**Severity:** Warning

**Why:** Mutating a nested property of a `$state` object is not tracked.

**Impact:** UI may not update. Use immutable updates or `$store`.

**Fix:**

```js
// Wrong
state.user.name = 'Alice' // FICT-M

// Correct
state = { ...state, user: { ...state.user, name: 'Alice' } }
```

### FICT-H: Dynamic property access

**Severity:** Warning

**Why:** Dynamic property access (e.g., `obj[key]`) widens dependency tracking.

**Impact:** More updates than necessary.

**Fix:** Prefer static property access where possible.

### FICT-HIR-UNSUPPORTED: Unsupported syntax in HIR conversion

**Severity:** Error

**Why:** The HIR conversion encountered syntax that it cannot faithfully represent.

**Impact:** Compilation fails to avoid silently changing runtime behavior.

**Common triggers:**

- Array literal holes: `[ , 1 ]`
- JSX spread children: `<div>{...items}</div>`
- Unsupported destructuring patterns in variable declarations/assignments (e.g. computed keys, nested patterns, or rest elements that are not simple identifiers)

**Fix:** Rewrite to supported forms:

```js
// Array holes: use explicit undefined values
const arr = [undefined, 1]

// JSX spread children: render explicitly
<div>{items}</div>

// Destructuring: use simple identifiers
const { value } = obj
```

---

## Notes

- Compiler emits additional internal codes during transformation that are not exposed as lint rules.
- Keep lint and compiler versions in sync to ensure consistent warning surface in editor and build logs.
- Some diagnostics can be suppressed with directive comments (feature planned).

## See Also

- [reactivity-semantics.md](./reactivity-semantics.md) — Reactive behavior rules
- [compiler-spec.md](./compiler-spec.md) — Compiler transformation details
