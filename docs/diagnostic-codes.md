# Diagnostic Codes Reference

This document provides detailed explanations for Fict compiler diagnostics. Each entry includes:

- **Why** — What triggered this diagnostic
- **Impact** — How it affects runtime behavior
- **Fix** — Recommended solutions

Codes surface at compile time and via `@fictjs/eslint-plugin` where applicable.
Some diagnostics are compiler-only, some are lint-only, and a few are reserved for future checks.
The machine-readable status and integration rules live in
[`diagnostics/registry.json`](../diagnostics/registry.json); CI requires every heading below to be
active and producer-backed, and prevents retired codes from returning to official integrations.

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

## State and placement

### FICT-PLACEMENT-STATE-TARGET: Invalid state binding target

**Severity:** Error

**Why:** The result of `$state` is assigned to a target that cannot own reactive state, such as a
module binding or a non-local assignment target.

**Impact:** The compiler cannot attach the state lifecycle to a component or hook local binding.

**Fix:** Declare the state as a local binding inside the owning component or hook:

```js
// Wrong — mutation outside component scope
let count
function Counter() {
  count = $state(0) // FICT-PLACEMENT-STATE-TARGET
  return <button onClick={() => count++}>Inc</button>
}

// Better — the local binding has an unambiguous owner
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

## Reactive placement

### FICT-PLACEMENT-STATE-CONTROL: State creation in control flow

**Severity:** Error

**Why:** `$state` appears inside a conditional block or loop.

**Impact:** State slots must be created unconditionally to retain stable lifecycle identity.

**Fix:** Move declarations to top level:

```js
// Wrong
if (condition) {
  let x = $state(0) // FICT-PLACEMENT-STATE-CONTROL
}

// Correct
let x = $state(0)
if (condition) {
  // use x
}
```

The same code is used for a state declaration inside a loop. Move the declaration outside the
conditional or loop and only branch on reads of the state.

### FICT-PLACEMENT-EFFECT-CONTROL: Effect creation in control flow

**Severity:** Error

**Why:** `$effect` appears inside a conditional block or loop. `$memo` uses the corresponding
`FICT-PLACEMENT-MEMO-CONTROL` code.

**Impact:** Effect and memo owners would change with the branch or iteration count.

**Fix:** Create the primitive unconditionally, then put the conditional logic inside its callback:

```js
// Wrong
if (enabled) {
  $effect(() => sync(value)) // FICT-PLACEMENT-EFFECT-CONTROL
}

// Correct
$effect(() => {
  if (enabled) sync(value)
})
```

### FICT-PLACEMENT-HOOK-CONTROL: Hook call in control flow

**Severity:** Error

**Why:** A hook-like function is called inside a conditional block or loop.

**Impact:** The hook's state and effect slots would not have stable ordering.

**Fix:** Call the hook unconditionally and branch on its returned values.

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

### FICT-J004: `dangerouslySetInnerHTML` with JSX children

**Severity:** Error

**Why:** A native element declares both `dangerouslySetInnerHTML` and renderable JSX children.

**Impact:** DOM lowering would write `innerHTML` and then append child nodes, producing ambiguous and unsafe output.

**Fix:** Use either `dangerouslySetInnerHTML` or JSX children on a native element, never both. Formatting-only multiline whitespace and JSX comments do not count as children; component props are unaffected.

### FICT-J005: JSX spread child

**Severity:** Error

**Why:** JSX spread-child syntax such as `<div>{...items}</div>` has no stable source-level
rendering contract in Fict. This does not affect JSX spread attributes such as `<div {...props} />`.

**Impact:** Lowering the expression as one child or as many children would produce ambiguous
rendering, ownership, and update semantics.

**Fix:** Render the collection explicitly, for example with
`{items.map(item => <Item key={item.id} item={item} />)}`.

---

## Regions/Scopes (FICT-R\*)

### FICT-R002: Scope escape detected

**Severity:** Error (default)

**Why:** A reactive binding escapes its declaration scope.

**Impact:** Similar to FICT-S002. Updates may not propagate correctly.

### FICT-R004: Reactive primitive in control flow

**Severity:** Error (default)

**Why:** A runtime reactive primitive (`createEffect`, `createMemo`, `createSelector`) is created inside non-JSX control flow without a scope boundary.

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
as a supported branch binding. Same-module hook-return accessors inferred after core region
planning also fail closed here when the surrounding control flow is not a supported branch return.
Structured synchronous hook `if`/`switch`/loop forms that assign observable locals are instead
lowered into one live memo region when their declarations can move atomically and the construct
contains no authored `return` or `throw`.
The diagnostic is also required when `lazyConditional: false` disables the EmitIR
`ConditionalReturn` capability for an otherwise supported reactive return.

**Impact:** In opt-out builds, reactivity remains semantic-first, but updates may execute broader
code paths than supported branch-return or story-block regions. For active branch reads, branch
output can be remounted to keep events, refs, style/class object handling, prop removal, and
cleanup semantics correct. DOM identity inside that remounted branch is not guaranteed.

**Fix:** Use supported `if-return` / `switch-return` / equivalent `try` return shapes, a memoized
story block that assigns locals consumed by JSX, or expression-only branching in JSX
(`cond ? <A/> : <B/>`, logical expressions). Keep arbitrary calls out of control-flow predicates
unless you intentionally compile that boundary with non-production `strictGuarantee: false`.
Keep `lazyConditional` enabled when branch returns must update after mount.

**Strict mode:** Set compiler `strictReactivity: true` to treat `FICT-R006` as a build error by
default. You can still override it with `warningLevels`.
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

### FICT-R-ALIAS-WRITE: Write to a read-only reactive alias

**Severity:** Error

**Why:** A local assigned from state, including a destructured or transitive alias, is a
compiler-managed read view. Replacing or updating that local would not update the original state
and can otherwise leave rendered output stale or defer the failure to a runtime `TypeError`.

**Impact:** Direct assignment, compound assignment, update, assignment-pattern, and captured
closure writes to the alias fail compilation. Projected mutations such as `alias[key]++` and method
calls that are not certified receiver-read-only use `FICT-M` because they mutate, or may mutate, the
current nested value rather than replace the signal. Certification is receiver-aware, not based on
the property name alone; an opaque alias with a method named `get` is still unproven. An explicit
built-in `$state<T>` receiver contract or same-family initializer and replacement chain can retain
the proof, while an unproven or different-family replacement invalidates it. Whole-value assignment
to the original state binding remains supported; projected writes through that root use the same
`FICT-M` policy.

**Fix:** Update the original state binding or assign the replacement to a new ordinary local:

```ts
let state = $state({ count: 0 })
const { count } = state

// Triggers FICT-R-ALIAS-WRITE
count++

// Replace the original shallow signal value instead
state = { ...state, count: state.count + 1 }
```

This diagnostic is always a hard error. `strictGuarantee: false`, `warningLevels`, and
`fict-ignore` cannot suppress it.

### FICT-R-DERIVED-WRITE: Write to a derived declaration

**Severity:** Error

**Why:** A value declared from state dependencies is emitted as a compiler-managed derived
accessor. Reassigning the declaration would replace the derived graph node instead of updating its
source state.

**Impact:** Direct, compound, update, and assignment-pattern writes to the derived binding fail
compilation. An explicitly mutable `let` initialized from a computed state value remains an
ordinary snapshot.

**Fix:** Update the source state, or compute the replacement under a new local name:

```ts
let count = $state(0)
const doubled = count * 2

// Triggers FICT-R-DERIVED-WRITE
doubled = 4

// Update the owner instead
count = 2
```

This diagnostic is always a hard error. `strictGuarantee: false`, `warningLevels`, and
`fict-ignore` cannot suppress it.

### FICT-R-CYCLE: Cyclic derived dependency

**Severity:** Error

**Why:** Two or more derived bindings depend on each other, or one derived binding references
itself. The resulting memo graph has no valid evaluation order.

**Impact:** Emitting the graph would create recursively evaluating accessors that can overflow the
stack or loop at runtime.

**Fix:** Break the cycle by deriving both values from an independent state source, or compute the
mutually dependent values together in one acyclic derivation. This diagnostic is always a hard
error: `strictGuarantee: false` and `warningLevels` cannot downgrade or suppress it.

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

### FICT-TS-DECORATOR-STANDARD: Standard decorators require lowering

**Severity:** Error

The pinned OXC transform preserves standard decorator syntax instead of
producing JavaScript that Fict's supported Node targets can execute. Lower the
decorators with a target-compatible transform, or remove them, before native
Fict compilation. Legacy TypeScript parameter decorators remain supported by
the explicit legacy lowering path.

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

**Why:** Mutating a nested property of a `$state` object, including through a reactive alias, is
not tracked with setter semantics. Method calls on a `$state`-derived object follow the same rule:
methods such as `Map#get`, `Set#has`, `Array#map`, and `Date#getTime` are allowed only when the
compiler also proves that built-in receiver family. A method name alone is never proof: custom,
shadowed, replaced with an unproven family, and otherwise unknown receivers fail closed even when
their method is named `get`, `map`, or `toString`. `$store` methods are not subject to this
shallow-signal policy.

**Impact:** UI may not update. The diagnostic is an error under the default `strictGuarantee` and
a warning only in explicit fallback mode. Use immutable updates or `$store`.

**Fix:**

```js
// Wrong
state.user.name = 'Alice' // FICT-M
state.values.set('key', 1) // FICT-M
state.customMutator() // FICT-M unless the receiver operation is compiler-certified read-only

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

**Fix:** Make the metadata source authoritative and current: publish package metadata, use the Vite
or Webpack graph integration, or break the metadata cycle. A custom direct host must resolve
`scan` results into `ResolvedMetadataInput[]` and pass them through `CompileRequest.metadata`;
Vite-only virtual module integrations may use the plugin's integration-level
`resolveModuleMetadata` hook. A hook that intentionally returns only plain values may publish
empty current metadata to prove that shape.

**Verification:** Native missing/opaque metadata and cycle behavior is covered by
`crates/fict-compiler/src/pipeline.rs`, `packages/vite-plugin/src/__tests__/native-backend.test.ts`,
and `packages/webpack-plugin/src/__tests__/resolver-boundary.test.ts`.

### FICT-HIR-MACRO-OPTIONAL: Optional compiler macro call

**Severity:** Error

**Why:** A compile-time macro such as `$state`, `$effect`, or `$memo` is called through optional
chaining. Runtime creators such as `createMemo?.(...)` are ordinary JavaScript and are not covered
by this diagnostic.

**Impact:** The compiler cannot give an optional macro call stable slot semantics.

**Fix:** Call compiler macros directly after handling optionality outside the macro call.

Other `FICT-HIR-*` and `FICT-OXC-EMIT-*` diagnostics are internal verifier/emitter failures rather
than a generic unsupported-syntax bucket. Preserve their exact code and report the smallest source
fixture; do not rewrite supported JavaScript merely to avoid an internal code.

### FICT-HIR-MACRO-UNBOUND: Compiler macro is not imported

**Severity:** Error

**Why:** An unresolved call uses the reserved `$state`, `$effect`, or `$memo` spelling without a
matching named import from a Fict entrypoint.

**Impact:** The call would otherwise remain in emitted JavaScript and fail at runtime instead of
receiving compiler semantics.

**Fix:** Import the macro by name from `fict`. A locally declared function with the same name, or a
binding imported from another package, remains an ordinary JavaScript call.

### FICT-HIR-MACRO-NAMESPACE: Compiler macro accessed through a namespace

**Severity:** Error

**Why:** A Fict namespace import accesses `$state` or `$effect` through a static or statically known
computed property, such as `Fict.$state()` or `Fict['$state']()`.

**Impact:** Namespace access cannot carry the direct imported binding identity required for macro
lowering.

**Fix:** Replace the namespace access with a named import and direct call. Namespace `$memo` is a
supported runtime accessor creator and does not produce this diagnostic.

### FICT-HIR-MACRO-VALUE: Compiler macro used as a runtime value

**Severity:** Error

**Why:** A named compiler macro import is referenced without being called directly.

**Impact:** Compiler macros have no runtime value contract and cannot be stored, passed, or
returned.

**Fix:** Call the imported macro directly at the use site.

### FICT-NATIVE-LOAD: Native compiler could not be loaded

**Severity:** Error

**Why:** Editor tooling could not load the platform-specific native compiler package.

**Impact:** The editor falls back to static analysis and cannot provide native compiler traces.

**Fix:** Reinstall dependencies for the current platform and verify the matching
`@fictjs/compiler-*` package is present.

### FICT-NATIVE-HOST: Native compiler host failure

**Severity:** Error

**Why:** Editor tooling caught an unexpected exception while invoking the native compiler host.

**Impact:** The editor falls back to static analysis for that request.

**Fix:** Follow the underlying message and report the fixture if the failure is reproducible. Normal
compile failures are returned as their exact structured diagnostic codes and do not use a generic
tooling alias.

---

## Notes

- Compiler emits additional internal codes during transformation that are not exposed as lint rules.
- Keep lint and compiler versions in sync to ensure consistent warning surface in editor and build logs.
- Diagnostics can be suppressed with `fict-ignore` / `fict-ignore-next-line` when strict guarantee mode is disabled.
- `strictGuarantee` blocks suppression for covered guarantee diagnostics.

## See Also

- [reactivity-semantics.md](./reactivity-semantics.md) — Reactive behavior rules
- [compiler-spec.md](./compiler-spec.md) — Compiler transformation details
