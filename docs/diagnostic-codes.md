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

**Severity:** Error (default)

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

**Severity:** Error (default)

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

**Severity:** Error (default)

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

**Severity:** Error (default)

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

## Memo (FICT-M\*)

### FICT-M001: Memo has no reactive dependencies

**Severity:** Info

**Why:** An explicit `$memo` callback doesn't depend on any reactive sources.

**Impact:** The memo is effectively a constant. This may indicate a logic error.

**Fix:** Verify the computation should depend on reactive values, or replace the explicit `$memo` with a plain constant.

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

### FICT-J003: Native element spread may hide unsupported props

**Severity:** Error (default)

**Why:** Spreading props onto a native element (`<div {...props} />`) makes it harder to reason about which DOM attributes are being passed through.

**Impact:** Unknown or overly broad native props can slip through and may use a less explicit update path.

**Fix:** Prefer explicit native props when granularity or DOM safety matters:

```js
// Less explicit for native DOM props
<div {...props} />

// More explicit
<div id={props.id} title={props.title} />
```

---

## Regions/Scopes (FICT-R\*)

### FICT-R002: Scope escape detected

**Severity:** Error (default)

**Why:** A reactive binding escapes its declaration scope.

**Impact:** Similar to FICT-S002. Updates may not propagate correctly.

### FICT-R003: Control-flow fallback lowering

**Severity:** Error (default)

**Why:** Reactive `if`/`switch` return lowering was skipped for a branch shape the compiler
cannot safely lower into fine-grained branch bindings.

**Impact:** Branch structure may rely on a fallback path instead of strict fine-grained lowering.
Reactivity is preserved, but updates can be coarser than expected. If active branch reads must be
tracked, the runtime remounts that branch output rather than partially patching it.

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

**Severity:** Error (default)

**Why:** A closure that captures reactive values escapes through an unknown or async callback boundary.

**Impact:** Dependency boundaries may become implicit and harder to reason about.
Non-escaping callbacks for common synchronous iterator patterns like `map`/`filter`/`forEach` are not flagged.
Async hosts such as `Promise.then` / `catch` / `finally` are treated as boundary crossings.

**Fix:** Keep the closure local to JSX/events/synchronous iterator callbacks, pass an explicit snapshot,
or route reactive work through a known Fict scheduling primitive such as `batch`, `untrack`, or
`startTransition`. If an external callback host is intentionally responsible for reactivity, disable
`strictGuarantee` only for that compilation boundary and cover the integration with tests.

### FICT-R006: Reactive control-flow re-execution

**Severity:** Error (default)

**Why:** Reactive values are read in a control-flow predicate that the compiler cannot place
inside a guaranteed branch-return lowering or memoized control-flow region. Common examples are
call-based predicates (`if (state > 0 && maybe())`) and loop/branch shapes that cannot be lowered
as a supported branch binding.

**Impact:** In opt-out builds, reactivity remains semantic-first, but updates may execute broader
code paths than supported branch-return or story-block regions. For active branch reads, branch
output can be remounted to keep events, refs, style/class object handling, prop removal, and
cleanup semantics correct. DOM identity inside that remounted branch is not guaranteed.

**Fix:** Use supported `if-return` / `switch-return` / equivalent `try` return shapes, a memoized
story block that assigns locals consumed by JSX, or expression-only branching in JSX
(`cond ? <A/> : <B/>`, logical expressions). Keep arbitrary calls out of control-flow predicates
unless you intentionally compile that boundary with non-production `strictGuarantee: false`.

**Strict mode:** Set compiler `strictReactivity: true` to treat `FICT-R003` and
`FICT-R006` as build errors by default. You can still override per code with `warningLevels`.
`strictGuarantee` is enabled by default for fail-closed behavior where non-guaranteed reactivity
diagnostics cannot be suppressed or downgraded. Production compilation (`NODE_ENV=production`)
force-enables it even when an integration passes `strictGuarantee: false`. Set
`strictGuarantee: false` only when intentionally opting out in non-production migration or
benchmark builds.
Set `FICT_STRICT_GUARANTEE=1` in CI to force-enable strict mode globally.
For the overall guarantee/fallback/unsupported map, see `docs/reactivity-guarantee-matrix.md`.

### FICT-R007: Reactive write in JSX child expression

**Severity:** Error (default)

**Why:** A JSX child expression writes to reactive state while the compiler is
trying to install the child as a DOM binding.

**Impact:** The write cannot be represented as a stable DOM binding without
mixing render reads and writes. In opt-out builds this is reported as a warning;
under `strictGuarantee` the build fails closed.

**Fix:** Move the write into an event handler, effect, or statement before the
JSX return:

```tsx
// Triggers FICT-R007
return <div>{count++}</div>

// Prefer an explicit statement boundary
count++
return <div>{count}</div>
```

---

## Performance (FICT-X\*)

### FICT-X003: Inline function in JSX

**Severity:** Hint

**Why:** A non-event inline function is passed as a JSX prop.

**Impact:** In Fict, normal DOM event handlers are usually fine because handler references stay stable. This hint is for non-event props where child components may care about reference identity (for example memoized render props).

**Fix:** If needed, extract to a named function:

```js
// Triggers FICT-X003
<MemoizedButton renderLabel={() => label} />

// Usually fine in Fict
<button onClick={() => count++} />

// Extract if a non-event prop needs stable identity
const renderLabel = () => label
<MemoizedButton renderLabel={renderLabel} />
```

---

### FICT-FUNCTION-ASYNC-COMPONENT: Async component under the synchronous render ABI

**Severity:** Error

Async components return promises, but the component invocation ABI requires a
synchronous Fict node. Move asynchronous work into an ordinary helper and keep
the component itself synchronous.

### FICT-FUNCTION-GENERATOR-COMPONENT / FICT-FUNCTION-GENERATOR-HOOK: Generator render owner

**Severity:** Error

Generator components and hooks return iterators instead of the synchronous node
or hook value required by the runtime ABI. Move iterator work into an ordinary
helper.

### FICT-FUNCTION-ASYNC-HOOK-AFTER-AWAIT: Render setup after suspension

**Severity:** Error

An async hook may read an accessor created before its first suspension, but it
must not create JSX, call another hook, or create reactive render state after an
`await`. Move all hook and JSX setup before the first suspension.

### FICT-COMPONENT-CLASS: Class binding used as a JSX component

**Severity:** Error

Fict components use a synchronous function invocation ABI. A local class,
class-expression binding, or statically known class-valued member cannot be used
as a JSX component because invoking it without `new` would fail at runtime.
Replace the class component with a function component; ordinary non-JSX class
helpers remain supported.

### FICT-TS-NAMESPACE-REFERENCE: Unsafe TypeScript namespace reference

**Severity:** Error

The TypeScript namespace compatibility pass could not preserve a namespace
member reference or write. This includes references from one merged declaration
segment to a non-exported binding owned by another segment and syntax positions
that cannot be synchronized through the namespace object safely. Export the
shared binding, or keep its declaration and all uses in the same namespace
segment.

### FICT-USING-UNSUPPORTED: Explicit resource management is not modeled

**Severity:** Error

`using` and `await using` declarations require disposal on every normal and
abrupt scope exit. Fict rejects them until those lifetime edges are represented
in HIR; otherwise reactive rewriting could silently omit or reorder disposal.
Use explicit `try`/`finally` cleanup outside compiler-owned reactive lowering.

---

## Misc (Legacy / Generic)

These warnings are emitted by the compiler but are not part of the numbered FICT-\* catalog.

### FICT-M: Direct mutation of nested `$state`

**Severity:** Error (default)

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

**Severity:** Error (default)

**Why:** Dynamic property access (e.g., `obj[key]`) widens dependency tracking.

**Impact:** More updates than necessary.

**Fix:** Prefer static property access where possible.

### FICT-H002: Inconsistent hook return accessor shape

**Severity:** Error under `strictGuarantee` (default); Warning in opt-out builds.

**Why:** A hook returns the same field (object key, array slot, or the direct
return value) with incompatible shapes across branches: a reactive accessor in
one branch and a plain value in another, or different reactive accessor kinds
such as a signal in one branch and a memo in another. The return shape is part
of the hook's ABI — same-file consumer rewriting and cross-package metadata both
require each slot to be consistently a plain value or consistently the same
reactive accessor kind. A mixed shape is ambiguous: the consumer cannot both
call `t.count()` and read `t.count`, and writable signal semantics are different
from read-only memo semantics.

```ts
function useThing(flag) {
  let count = $state(0)
  if (flag) return { count } // accessor
  return { count: 'off' } // plain value — FICT-H002
}
```

**Impact:** Under `strictGuarantee` the build fails closed. In opt-out builds
the conflicting slot is not published as an accessor and a warning is emitted.

**Fix:** Return a consistent shape from every branch:

```ts
// Always a plain value:
return flag ? { count: count() } : { count: 'off' }

// Always the same accessor kind:
return flag ? { count } : { count: () => 'off' }
```

### FICT-H003: Imported hook metadata unavailable

**Severity:** Error under `strictGuarantee` (default); Warning in opt-out builds.

**Why:** A hook-like import is used, or a module is re-exported, before the compiler integration can
prove its current reactive shape. This includes unresolved aliases, packages without published
Fict metadata, and module cycles that cannot produce complete metadata. Calling the result as an
accessor without that proof could turn a plain value into a runtime `TypeError`; treating an
accessor as plain could instead produce invalid arithmetic or stale UI.

**Impact:** Strict builds stop rather than emit code with guessed hook semantics. Opt-out builds
retain the opaque value behavior and emit a warning.

**Fix:** Make the metadata source authoritative and current: publish package metadata, configure an
explicit `moduleMetadata` / `resolveModuleMetadata` integration, use the Vite or Webpack graph
integration, or break the metadata cycle. A hook that intentionally returns only plain values may
publish empty current metadata to prove that shape.

**Verification:** The importer-first, transitive stale graph, unresolved alias/package, and cycle
cases are covered by `packages/compiler/test/babel-typescript-integration.test.ts`.

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

### FICT-COMPILE: Tooling compiler failure

**Severity:** Error

**Why:** Compiler tooling caught a thrown compiler error and normalized it into
an editor/playground diagnostic.

**Impact:** The source could not be transformed. The diagnostic message is the
first line of the original compiler error with the best location the tooling can
infer.

**Fix:** Follow the underlying message. If the message contains another
`FICT-*` code, use that code's documentation for the specific remediation.

---

## Notes

- Compiler emits additional internal codes during transformation that are not exposed as lint rules.
- Keep lint and compiler versions in sync to ensure consistent warning surface in editor and build logs.
- Diagnostics can be suppressed with `fict-ignore` / `fict-ignore-next-line` when strict guarantee mode is disabled.
- `strictGuarantee` blocks suppression for covered guarantee diagnostics.

## See Also

- [reactivity-semantics.md](./reactivity-semantics.md) — Reactive behavior rules
- [compiler-spec.md](./compiler-spec.md) — Compiler transformation details
