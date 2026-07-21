# Fict Architecture

> It looks like normal TSX, but inside Fict is a compiler-first framework that converts React-like semantics into fine-grained reactive primitives.

For the rigorous Formal Semantics specification (v1.0), please refer to [compiler-spec.md](./compiler-spec.md#15-appendix-formal-semantics-v10).

This document outlines the high-level engineering architecture. from an engineering perspective:

- How the compiler understands `$state` / `$effect`
- How the dependency graph is built and how the DOM is updated
- Why components "run only once" but still feel intuitive
- How edge semantics (events, async, side effects) are guaranteed to be consistent
- How runtime errors are caught and isolated
- How props stay reactive (even through destructuring/spread) without re-rendering components

---

## 1. Overview: From TSX to DOM Update

A component using Fict looks roughly like this:

```tsx
export function Counter() {
  let count = $state(0)
  const doubled = count * 2

  $effect(() => {
    document.title = `Count: ${count}`
  })

  return <button onClick={() => count++}>{doubled}</button>
}
```

From a toolchain perspective, it goes through several stages:

1. **TSX Source Code**
   Normal TypeScript + JSX.

2. **Fict Compiler (TS transform / SWC/Babel Plugin)**
   - Marks `$state` sources
   - Analyzes derived expressions
   - Identifies dynamic bindings in JSX
   - Identifies dependencies in `$effect`
   - Produces a **Reactive IR (Intermediate Representation)**

3. **Runtime Code**
   Maps IR to:
   - Fine-grained "signal" structures (state/memo/effect)
   - DOM Patch functions
   - Lifecycle management (mount, cleanup)

4. **Browser Execution**
   - Component function executes **once** upon first mount
   - Builds dependency graph and initial DOM
   - Subsequently triggers local updates only based on state changes

---

## 2. Component Execution Model

### 2.1 Single-Pass Component Execution

Fict components execute once at mount time. Updates are handled by compiler-emitted reactive bindings/memos, not by re-running the whole component body.

```ts
function Component(props) {
  // Here we build: state, derived values, effects, event handlers, JSX bindings
  // Then return JSX
}
```

**The key insight**: control-flow reads are lowered into reactive branch bindings for supported return shapes.

#### Control Flow Triggers Branch Reactivity

When a signal or derived memo is **read at runtime** in supported control-flow return shapes, the compiler emits branch bindings that swap output reactively:

```tsx
// Branch output updates when count changes
let count = $state(0)
const doubled = count * 2 // just defines a derived memo

if (doubled) {
  // `doubled` is READ at runtime in control flow
}

return <>{count}</>
```

When `count` changes, branch output is re-evaluated without re-running the entire component body.
If the active branch itself must be re-executed because it reads reactive values outside the
fine-grained JSX binding path, Fict remounts that branch output. This is intentionally conservative:
event handlers, refs, style/class objects, removed props, and branch-local cleanup stay correct, but
DOM identity inside that fallback branch is not preserved.
Note: simply defining `const doubled = count * 2` doesn't trigger branch bindings by itself.

#### JSX-Only Usage Triggers Fine-Grained Updates

When signals are only read in JSX expressions (not read at runtime in control flow), only the specific DOM nodes update:

```tsx
// Only FINE-GRAINED DOM update
let count = $state(0)
const doubled = count * 2 // defined but never read in control flow

return <>{count}</>
```

When `count` changes, only the text node updates. The component body still does not re-run.

#### Concrete Example: What Runs When?

This example demonstrates exactly which parts of your code run and when:

```tsx
function Counter() {
  console.log('index0') // 🔵 Runs ONCE (initialization)
  let count = $state(0)
  const doubled = count * 2
  console.log('index1', doubled) // 🟢 Runs on EVERY count change
  return (
    <button onClick={() => count++}>
      {(console.log('index2'), doubled)} {/* 🟢 Runs on EVERY count change */}
      {(console.log('index3'), 'static')} {/* 🔵 Runs ONCE (no dependency) */}
    </button>
  )
}
```

**Initial render output:**

```
index0        ← Component body starts (once)
index1 0      ← Derived value memo executes
index2        ← JSX binding with reactive dependency
index3        ← JSX binding without dependency (static)
```

**After clicking the button (count: 0 → 1):**

```
index1 2      ← Derived memo recomputes (doubled = 1 * 2)
index2        ← JSX binding updates
              ← index0 and index3 do NOT execute again!
```

**Why this behavior?**

The compiler analyzes your code and splits it into reactive regions:

1. **Initialization region** (`index0`): Code before any reactive dependencies - runs once
2. **Derived memo** (`index1`): Expression `count * 2` depends on `count` - recomputes when `count` changes
3. **Reactive JSX binding** (`index2`): Uses `doubled` - updates when `doubled` changes
4. **Static JSX binding** (`index3`): No reactive dependencies - runs once

This is fundamentally different from:

- **React**: The entire function re-runs on every state change (all 4 logs every time)
- **Solid**: The function runs once, but you must explicitly wrap derived values in `createMemo`

Fict gives you the best of both worlds: React's familiar syntax with Solid's fine-grained updates.

During initial execution, the compiled code will:

- Assign a "Source Node" (signal) for each `$state`
- Assign "Derived Nodes" (memo) for each required derived expression
- Register a "Side Effect Node" for each `$effect`
- Create "Binding Nodes" (update functions) for dynamic parts in JSX
- Track which signals/memos are **read at runtime** in control flow for branch-binding lowering

Eventually forming a graph:

```text
$state ──▶ memo ──▶ binding
       └──▶ effect
       └──▶ control flow (triggers branch binding)
```

### 2.5 Props Stay Reactive Outside Render

Fict keeps props reactive even when they are reshaped before reaching JSX:

- **Destructuring**: Compiler rewrites `({ value })` (and nested/default patterns) into lazy getters backed by the original props source. Derived values built from these getters become memos by default (or plain getters under `"use no memo"`), so no stale snapshots.
- **Spread into components**: Object literals, const objects (even nested spreads or `useMemo` factories) are scanned and reactive entries are wrapped with lazy getters/`prop` automatically before spreading into child components. This keeps props lazy without forcing DOM insert bindings.
- **Manual merge**: `mergeProps(a, b, { c })` merges props while preserving getters; later sources override earlier ones. Compiler emits this automatically when needed; explicit calls are only for truly dynamic shapes you build at runtime.
- **Known limit**: If a spread argument is a runtime-dynamic object whose shape is unknown (e.g., function return with dynamic keys), the compiler cannot safely rewrite its fields. In such cases, mark reactive fields yourself or call `mergeProps` explicitly.
- **Public helpers** (rarely needed):
  - `prop(() => value)` for rare manual wrapping needs (e.g., truly dynamic objects). `prop` memoizes and auto-unwraps when passed through props.

### 2.5.1 When to use prop / mergeProps (pre-compiled code)

The compiler already wraps destructuring/rest/spread/children for you. Manual helpers are only needed in corner cases:

- **Runtime-built objects with unknown keys** the compiler can’t inspect:

  ```ts
  function getPayload() {
    // dynamic keys/shape at runtime
    return buildDynamicObject()
  }
  // To keep reactive fields live, wrap reactive ones manually or use mergeProps:
  return <Row {...mergeProps(getPayload())} />
  ```

- **Heavy computations you explicitly want memoized**:

  ```ts
  const data = prop(() => expensiveFilter(list, filter))
  return <Table data={data} />
  ```

- **Mark specific reactive fields on a dynamic shape**:

  ```ts
  function getSettings() {
    return { theme, user: prop(() => currentUser), staticFlag: true }
  }
  return <Dashboard {...mergeProps(getSettings())} />
  ```

- **Interop / escape hatches**: when passing third-party objects or functions where the compiler cannot safely inject getters, annotate the reactive parts with `prop` or wrap with `mergeProps`.

For everyday props/destructuring/spread patterns, rely on the compiler’s automatic wrapping; no manual helpers required.

### 2.5.2 State destructuring (read-only aliases)

- Declaring `$state` with destructuring is still illegal: `const { id } = $state(...)` → compile error.
- Destructuring an existing `$state` object, e.g. `let state = $state({ count: 0 }); const { count } = state;`, is rewritten to a memo accessor (or plain getter under `"use no memo"`), so reads in JSX/logic stay reactive.
- Writes to the alias (`count++`, `count = ...`) are disallowed. Replace the original shallow signal value (`state = { ...state, count: state.count + 1 }`, including through immer/mutative) or use `$store` for direct nested mutation.
- The same read-only rule applies to direct aliases (`const alias = state`) and compiler-managed `const` declarations derived from state (`const doubled = count * 2`). Only the original state binding owns whole-value setter semantics; assignment, compound assignment, update, and assignment-pattern writes to its aliases fail compilation, including inside captured closures. Projected mutations such as `alias[key]++`, known collection/date/typed-array mutators, and unknown custom method calls follow `FICT-M`: they warn in fallback mode and fail under `strictGuarantee`. Receiver-read-only certification requires a statically proven built-in family as well as a matching method; property names on custom, shadowed, reassigned, or opaque alias receivers are not trusted. An explicitly mutable `let` initialized from a computed state value remains an ordinary snapshot.
- Dynamic keys / deep paths fallback to coarser subscriptions (more recompute). Static paths like `.count` get precise deps.

### 2.2 Comparison with React / Solid

| Framework | Component Execution Count                                            | Update Granularity       |
| :-------- | :------------------------------------------------------------------- | :----------------------- |
| React     | Re-executes entire component on every state change                   | Component-level + VDOM   |
| Solid     | Component executes once, internal signal graph                       | DOM-level                |
| Fict      | Component executes once; control-flow branches are reactive bindings | DOM-level (Fine-grained) |

Fict uses a compiler-first fine-grained model:

- Like Solid: Fine-grained DOM updates when signals are only used in JSX
- Branch returns (`if-return` / `switch-return` / equivalent `try` returns) are lowered to reactive conditionals
- Unlike React: No full component re-renders on each state update

---

## 2.3 Error Handling

- **ErrorBoundary**: Captures errors from rendering, event handlers, effects, and cleanups using the nearest boundary first, switches to the `fallback` view, and rebuilds the subtree when `resetKeys` change.
- **Uncaught errors**: If no boundary is registered or a handler returns `false`, the error continues to bubble so failures remain visible during development.
- **Cleanup safety**: Errors thrown during lifecycle cleanups are routed through the boundary to prevent the entire tree from crashing.

### 2.4 Suspense & Async Boundaries

- **Trigger scope**: Only Suspense tokens thrown along the render path (JSX/list/conditional/Portal) are caught by the nearest `<Suspense>`; events/`$effect` won't suspend by default, so throw a token explicitly if needed.
- **Resource coordination**: `resource({ fetch, suspense: true, key? })`'s `read()` throws a token while pending; `key` lets you reuse/share the same resource instance (across components or stable params) to avoid duplicate requests and leaks.
- **Lazy components**: `lazy(() => import('./Foo'))` throws a token while the module is still loading; once the fallback renders and the module resolves, it resumes automatically.
- **Parallel suspension**: Suspense counts tokens and only resumes after all resolve; rejects go to the nearest ErrorBoundary or `onReject`.
- **Best practices**:
  - Pass a `key` for resources with stable params (e.g. `[userId]`) to reuse caches; when params change or you refresh, changing the key re-suspends and refetches.
  - For "silent retries", wrap the region with an ErrorBoundary to catch rejects, or retry inside the resource before resolving.
  - Don't suspend implicitly inside events or effects; if you want users to see loading states, wrap the async data as a resource/lazy ahead of time and throw tokens from the render path.

---

## 3. $state: Signal Source Node

### 3.1 Syntax and Types

```ts
let count = $state(0)
```

At the source level:

- To the developer: `count` is a `number`
- To the compiler: `$state(0)` is a declaration of a "**Signal Source**"

After compilation, conceptually similar to:

```ts
const $count = createSignal(0) // Internal signal
let count = $count() // Current value variable (compiler rewrites reads/writes)
```

But actual implementation does more SSA/control flow analysis rather than simple replacement.

### 3.2 Read/Write Capture

All read/write positions involving `count` are marked:

- **Read**: `count` appears in an expression
- **Write**: `count = ...`, `count++`, `count += 1`

The compiler does two things:

1. At read positions, determine if it belongs to:
   - Derived expression
   - Inside an effect
   - JSX dynamic binding
   - Plain event/closure

2. At write positions, convert to update calls on the internal signal, triggering dependency updates.

### 3.3 When to Use `createSignal` Instead of `$state`

`$state` is a compiler macro that **can only be used at the top level of component or Hook function bodies**. For the following scenarios, use the underlying runtime function `createSignal`:

1. **Module-level shared state**:

   ```ts
   // store.ts - Create shared state at module top level
   import { createSignal } from 'fict/advanced'
   export const count = createSignal(0)
   ```

2. **Custom Hook returning a signal**:

   ```ts
   import { createSignal } from 'fict/advanced'
   export function useCounter(initial = 0) {
     const count = createSignal(initial)
     const setCount = (next: number) => count(next)
     return { count, setCount, increment: () => count(count() + 1) }
   }
   ```

3. **Non-Fict environments (tests, utility libraries)**:
   ```ts
   import { createEffect } from 'fict'
   import { createSignal } from 'fict/advanced'
   const value = createSignal(0)
   createEffect(() => console.log(value()))
   ```

> **Note**: For global state, also consider using `$store` (from `fict`), which supports deep reactivity and allows module-level declarations.

---

## 4. Derived Expressions: default memoization

A key design of Fict is: **Automatic memoization of derived expressions**.

### 4.1 Rules

All expressions dependent on `$state` (directly or indirectly) are memoized by default (unless `"use no memo"` disables auto memoization).

1. **Read in control flow**
   → Still memoized; supported return-branch shapes are lowered into reactive conditionals.

2. **Read in JSX / `$effect` / events / plain functions**
   → Memoized; events and plain functions read the current memo value.

3. **Opt-out**
   → With `"use no memo"`, derived values are lowered to plain getters/expressions; use `$memo` for explicit caching.

### 4.2 Example: Pure Derivation, Bound in JSX

```ts
let price = $state(100)
let quantity = $state(2)

const total = price * quantity

return <div>{total}</div>
```

IR will have nodes similar to:

```text
$price ───▶ memo(total) ───▶ binding(<div>{…}</div>)
$quantity ─┘
```

At runtime level:

- When `$price` / `$quantity` changes, recompute `memo(total)`
- Notify binding to update DOM

> Note: When a derived value is used only once, the compiler may inline the memo as an optimization. The conceptual model remains memoized; use `$memo` to force a memo node.

### 4.3 Example: Used Only in Event → memo

```ts
let count = $state(0)
const doubled = count * 2

const onClick = () => {
  console.log(doubled)
}
```

Conceptually becomes after compilation:

```ts
const $doubled = createMemo(() => $count.get() * 2)
const onClick = () => {
  console.log($doubled())
}
```

A memo node is established; the event reads the current memo value.

If you opt out with `"use no memo"`, the compiler lowers derived values to plain getters/expressions.

---

## 5. Fine-grained DOM pipeline

Fict uses fine-grained DOM updates as the only rendering mode:

- Runtime helper layer (`bindText`, `bindClass`, `bindStyle`, `createKeyedList`, `createVersionedSignal`, etc.) is in place.
- Fine-grained runtime execution is **the only mode**; `render()` annotates the container with `data-fict-fine-grained="1"` for debugging and monitoring.
- End-to-end scenarios (counter, keyed lists, nested conditionals, primitives) verify the fine-grained implementation.

The architecture is fully unified around fine-grained updates.

---

## 5. JSX Dynamic Binding: Binding Node

In TSX, Fict scans all JSX dynamic expressions:

```tsx
return (
  <button disabled={!isValid} onClick={submit}>
    {label}
  </button>
)
```

Here there are three dynamic points:

- `disabled={!isValid}`
- `onClick={submit}`
- `{label}`

For "attribute/children" bindings:

- Create a **binding node**, register in the dependency graph
- Binding is a function that can update the DOM, for example:

  ```ts
  function updateDisabled(newValue: boolean) {
    btn.disabled = newValue
  }
  function updateLabel(newLabel: string) {
    textNode.data = newLabel
  }
  ```

When related `$state` / memo changes, binding will be called.

---

## 6. $effect: Side Effect Node

### 6.1 Dependency Collection

```ts
$effect(() => {
  document.title = `Count: ${count}`
})
```

The compiler will:

- Collect `$state` / derived expressions used in the effect function body
- Establish a node for this effect:

```text
$count ──▶ effect(fn)
```

When `$count` changes:

1. First call the cleanup returned by the last run (if any)
2. Then call the new effect function

### 6.2 Async Effect and Cleanup

```ts
$effect(async () => {
  const ctrl = new AbortController()
  fetch('/api', { signal: ctrl.signal })
  return () => ctrl.abort()
})
```

Semantically:

- Every time dependencies change, the old request is aborted (cleanup called)
- Then a new request is initiated

For `async` effect, semantics are similar, but dependency collection only happens during synchronous execution.

---

## 7. Update Scheduling

### 7.1 Default Batching

Multiple `$state` writes within the same synchronous execution block are automatically batched:

```ts
const handleClick = () => {
  count = 1 // Does not trigger update immediately
  name = 'test' // Does not trigger update immediately
  // → Update dependency graph once after synchronous block ends
}
```

Implementation uses microtasks (`queueMicrotask`) to collect changes in the same tick.

### 7.2 Scheduling Priority (fict)

```ts
import { startTransition, useTransition, useDeferredValue } from 'fict'
```

- `startTransition(fn)`: Low priority, interruptible work suitable for page transitions
- `useTransition()`: React-style tuple `[isPending, start]` to coordinate pending UI state
- `useDeferredValue(fn)`: Accessor that lags behind the source during rapid updates
- Planned: `task(fn, { timing: 'layout' | 'idle' })` for finer scheduling (not implemented yet)

## 8. Control Flow Grouping: From "Per-Value Memo" to "Story Block"

Consider this typical example:

```ts
const count = videos.length
let heading = emptyHeading
let extra = 42

if (count > 0) {
  const noun = count > 1 ? 'Videos' : 'Video'
  heading = `${count} ${noun}`
  extra = computeExtra()
}

return (
  <>
    <h1>{heading}</h1>
    <h2>{extra}</h2>
  </>
)
```

A naïve approach would be:

- One memo for `heading`
- One memo for `extra`
- `count` is recalculated in multiple memos
- `if` condition is re-evaluated multiple times

This is both complex and wasteful.

### 7.1 Fict's Strategy: **Control Flow Region Grouping**

Fict identifies a logically interconnected "Control Flow Region":

- Uses `count`
- Affects both `heading` and `extra`
- Corresponds to a complete "story block"

Then compiles it into a single memo:

```ts
const $viewState = createMemo(() => {
  const count = videos.length
  let heading = emptyHeading
  let extra = 42

  if (count > 0) {
    const noun = count > 1 ? 'Videos' : 'Video'
    heading = `${count} ${noun}`
    extra = computeExtra()
  }

  return { heading, extra }
})
```

The JSX part becomes:

```tsx
const { heading, extra } = $viewState()

return (
  <>
    <h1>{heading}</h1>
    <h2>{extra}</h2>
  </>
)
```

This way:

- Complex logic retains original structure (readable)
- Only one memo node established (maintainable)
- Accurately recalculates this block when dependencies change (performance controllable)

---

## 9. Events and Closures: Snapshot vs Live

With Fict's getter/memo lowering model, event handlers always see the latest values. However, the compilation strategy differs based on usage:

```ts
let count = $state(0)
const doubled = count * 2

const click = () => {
  alert(doubled) // Always sees current value
}
```

Fict ensures this by rewriting reactive reads to getters and memoizing derived values by default.

To summarize:

- Derived **read at runtime** in supported control-flow return shapes → lowered to reactive branch bindings
- Derived read in **JSX / `$effect` / events / plain functions** → memo accessor (events read current memo value)
- With `"use no memo"` → derived values are lowered as plain getters/expressions unless explicitly `$memo`
- Simply defining a derived (`const x = signal * 2`) does NOT by itself create branch bindings

This matches developer intuition while optimizing for performance.

---

## 10. Advanced: $store / resource / Escape Hatches

This part covers advanced capabilities available in `fict` and `fict/plus`, not part of the minimal mental surface area.

### 9.1 $store: Path-level reactivity

`$store` enables fine-grained tracking of nested property access:

```ts
import { $store } from 'fict'

let form = $store({
  user: { name: '', email: '' },
  settings: { theme: 'light' }
})

// In JSX: only re-renders when `form.user.name` changes
<input value={form.user.name} />

// This update only triggers the input above,
// not anything that only reads `form.settings`
form.user.name = 'Alice'
```

#### How it works

The compiler tracks property access paths:

- `form.user.name` → subscribes to path `['user', 'name']`
- `form.settings.theme` → subscribes to path `['settings', 'theme']`

Updates notify only the specific paths that changed.

#### Automatic Memoization

Derived expressions consuming `$store` are **automatically memoized** by the compiler, just like `$state` derivations:

```ts
const fullName = store.user.firstName + ' ' + store.user.lastName
// Compiles to: const fullName = useMemo(() => store.user.firstName + ' ' + store.user.lastName)
```

This provides the same DX as `$state` while leveraging path-level Proxy tracking.

#### When to use $store vs $state

| Scenario                   | Recommended          |
| -------------------------- | -------------------- |
| Simple values              | `$state`             |
| Small objects (< 5 fields) | `$state` with spread |
| Complex forms              | `$store`             |
| Nested editors             | `$store`             |
| Lists with item mutations  | `$store`             |

### 9.2 resource: Async Data

```ts
import { reactive } from 'fict/advanced'
import { resource } from 'fict/plus'

const userResource = resource({
  key: (id: string) => ['user', id], // if omitted, args value is the key
  suspense: true,
  cache: { mode: 'memory', ttlMs: 10_000, staleWhileRevalidate: true },
  reset: reactive(() => sessionVersion()), // reset token changes will invalidate/refetch
  fetch: ({ signal }, id: string) => fetch(`/api/user/${id}`, { signal }).then(r => r.json()),
})

function User({ id }: { id: string }) {
  const user = userResource.read(reactive(() => id))
  return <div>{user.data?.name}</div>
}

// Control plane
userResource.prefetch('42') // warm up
userResource.invalidate(['user', '42']) // drop cached entry
```

- Requests sharing the same key are automatically deduplicated; the in-memory cache persists by default, and the `cache` option lets you configure TTL / SWR / whether errors are cached.
- Works with Suspense / ErrorBoundary: pending states throw suspend tokens, and once they resolve the cached data is reused without re-entering the fallback UI.
- `invalidate(key?)` clears the cache so the next read refetches; `prefetch` can warm data ahead of navigation.

### 9.3 Escape Hatches: untrack / "use no memo"

For areas that cannot be statically analyzed or where dependency collection is not desired, tracking can be explicitly turned off:

```ts
import { untrack } from 'fict'

$effect(() => {
  untrack(() => {
    thirdPartyMutableApi.doSomethingDangerous()
  })
})
```

For certain files/functions, you can tell the compiler via directive "only do minimal transformation, don't generate complex memo":

```ts
// "use no memo"

function WeirdComponent() {
  // ...
}
```

### 9.4 Error boundaries

> For detailed API reference, see [error-boundary.md](./error-boundary.md).

```tsx
import { ErrorBoundary } from 'fict'

function App() {
  return (
    <ErrorBoundary fallback={err => <ErrorPage error={err} />}>
      <RiskyWidget />
    </ErrorBoundary>
  )
}
```

Semantics (Target Design):

- Capture Scope: Errors thrown during rendering and `$effect` within the subtree; non-fatal exceptions are blocked at the nearest boundary.
- Display: `fallback` can be a node or function `(err) => JSX`, receiving the original error object.
- Recovery: When the error disappears (e.g., data change), the boundary attempts to re-render the subtree; can also expose `reset` callback for manual user retry.
- Interop: Compatible with `resource`/`transition`, errors won't bubble to global and crash the app.

---

## 10. Keyed List Runtime Semantics

Recent runtime changes introduced a managed-block implementation for keyed lists that preserves DOM identity, state, and event listeners across updates. This section documents the intentional design decisions and their implications.

### 10.1 Core Architecture: ManagedBlock

Each item in a keyed list gets its own `ManagedBlock<T>` containing:

- **Signals**: `valueSig`, `indexSig`, `versionSig` for tracking item state
- **DOM Markers**: `start`/`end` comment nodes defining block boundaries
- **Root Context**: Preserved across updates to maintain component lifecycle

When the list updates:

1. **Unkeyed lists**: Items with different references are destroyed and remounted (destructive update)
2. **Keyed lists**: Items are matched by key, signals are updated, and DOM is patched in-place (preserving identity)

### 10.2 Fine-Grained Lists (Keyed and Unkeyed)

- **Compiler output**: All mapped JSX now lowers to `createKeyedList`. When no explicit `key` is provided, the compiler falls back to `keyFn: (_, i) => i` and warns with `FICT-J002`.
- **Per-item signals**: Each block owns an item signal and (optionally) an index signal. Effects inside the block subscribe to those signals, so only changed items rerun.
- **Reconciliation**: Keys drive identity; DOM nodes are moved when order changes and reused when keys stay the same. Unkeyed lists still keep item order via the synthetic index key.
- **Mutation model**: Item updates are detected via reference equality. If you mutate objects in place without changing their reference, block effects will not rerun—prefer immutable updates or replace the item to trigger the setter.

### 10.3 Performance Guidance

- **Changed items only**: When keys and references are stable, unchanged items skip work. Reorders rely on DOM moves instead of destroy/remount.
- **Immutable updates recommended**: Return new objects when a row changes. For primitives, set a new value to trigger the item signal.
- **Large lists**: Continue to favor virtualized rendering or memoized rows for very large datasets; the fine-grained path minimizes but does not eliminate per-item overhead (signals + root per block).

### 10.4 Primitive Values

- `createKeyedList` always yields raw primitives; `typeof item()` and strict equality work as expected.

### 10.5 Incremental DOM Updates

To preserve DOM identity, `rerenderBlock` implements several fast paths:

1. **Text node → Text-like value**: Updates `.data` in-place
2. **Element → Simple element**: Patches tag/attributes/textContent if structure matches
3. **Same node instance**: Reuses without changes
4. **Fallback**: Clears content and inserts new nodes

This means:

- ✅ Event listeners survive rerender (attached to preserved elements)
- ✅ Input focus survives rerender (element identity preserved)
- ✅ Component state survives rerender (root context reused)
- ⚠️ Complex attribute changes (event handlers, style objects) may trigger fallback

### 10.6 Summary of Design Trade-offs

| Decision                            | Rationale                          | Trade-off                                      |
| ----------------------------------- | ---------------------------------- | ---------------------------------------------- |
| Primitive proxies expose prototypes | Preserves natural JS API           | `typeof` checks return `'object'`              |
| Keyed blocks always rerender        | Guarantees effect/DOM sync         | Performance cost for large lists               |
| Proxies are internal-only           | Maintains binding system integrity | Cannot use for custom scenarios                |
| Incremental DOM patching            | Preserves identity/state/events    | Limited attribute patching (simple props only) |

**Bottom Line**: Keyed lists prioritize **correctness and developer ergonomics** over raw performance. For performance-critical scenarios, use the optimization strategies documented above.

---

---

## 12. SSR & Streaming

Fict’s SSR executes compiled output inside a DOM simulation (linkedom) and serializes HTML.
`renderToString` returns a full HTML string, while streaming mode can emit a **shell-first**
response and patch Suspense boundaries as they resolve.

`renderToPartial` is available as an experimental preview for Partial
Prerendering workflows: it returns a complete shell HTML plus a deferred patch
stream, but its return shape is not frozen as stable v1 API surface.

### 12.1 Shell-first streaming

- Initial chunk contains fallback UI and boundary markers.
- As Suspense resolves, the server sends patch chunks that replace boundary contents.
- A tiny runtime patcher (`__FICT_STREAM`) applies patches on the client.

### 12.2 All-ready mode

- Waits for all Suspense boundaries to resolve.
- Emits a single complete HTML string (traditional SSR).

### 12.3 Snapshot timing

- In shell-first streaming, snapshots are emitted incrementally (shell + each
  resolved boundary) as `data-fict-snapshot` scripts, with any remaining scopes
  flushed at the end.
- When `snapshotTarget: 'head'`, each snapshot chunk injects into `<head>` via a
  small script. External runtime mode requires a non-empty `scriptNonce` for
  incremental head snapshots; nonce-free strict-CSP routes use container/body
  placement.

### 12.4 Edge runtime notes

- Use `renderToStream` in Edge runtimes; use `renderToPartial` from
  `@fictjs/ssr/experimental` only for Preview PPR workflows.
- `renderToPipeableStream` targets Node-style writable streams.
- `manifest` file path strings rely on runtime filesystem access (Node/Deno);
  edge environments should pass manifest objects.

## 13. Summary

- Fict's goal is not to "reinvent another framework that looks like React", but:
  - To let you write the **story the user sees** in TypeScript that is close to pseudocode;
  - To hand over complex reactive wiring and performance optimization to the compiler and runtime;
  - To retain the engineering advantages brought by TSX and existing toolchains.

- **Compiler-first fine-grained model**: Components execute once; updates flow through memo/binding nodes. Supported control-flow return shapes are lowered into reactive branch bindings while normal JSX reads stay fine-grained.

- From an architectural perspective, it stands on the shoulders of several predecessors:
  - React Compiler's automatic derivation idea
  - Million.js's compiler-assisted React performance exploration
  - Solid's fine-grained reactive graph
  - Svelte 5 / Vue's intuitive mutable syntax
  - A hybrid execution model that matches developer intuition
  - Plus a little bit of **"UI is fiction over real state"** paranoia.
