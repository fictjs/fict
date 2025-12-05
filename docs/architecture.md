# Fict Architecture

> It looks like normal TSX, but inside Fict is a compiler-first framework that converts React-like semantics into fine-grained reactive primitives.

For the rigorous Formal Semantics specification (v1.0), please refer to [compiler-spec.md](./compiler-spec.md#15-appendix-formal-semantics-v10).

This document outlines the high-level engineering architecture. from an engineering perspective:

- How the compiler understands `$state` / `$effect`
- How the dependency graph is built and how the DOM is updated
- Why components "run only once" but still feel intuitive
- How edge semantics (events, async, side effects) are guaranteed to be consistent

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

### 2.1 Single Execution

In Fict, each component function executes **once** when mounted:

```ts
function Component(props) {
  // Here we build: state, derived values, effects, event handlers, JSX bindings
  // Then return JSX
}
```

During execution, the compiled code will:

- Assign a "Source Node" (signal) for each `$state`
- Assign "Derived Nodes" (memo) for each required derived expression
- Register a "Side Effect Node" for each `$effect`
- Create "Binding Nodes" (update functions) for dynamic parts in JSX

Eventually forming a graph:

```text
$state ──▶ memo ──▶ binding
       └──▶ effect
```

### 2.2 Comparison with React / Solid

| Framework | Component Execution Count                                    | Update Granularity       |
| :-------- | :----------------------------------------------------------- | :----------------------- |
| React     | Re-executes entire component on every state change           | Component-level + VDOM   |
| Solid     | Component executes once, internal signal graph               | DOM-level                |
| Fict      | Component executes once, internal signal graph + compilation | DOM-level (Fine-grained) |

Fict is closer to Solid's execution model but uses a **TSX + Compiler Automatic Inference** style.

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
let count = $count.get() // Current value variable (compiler rewrites reads/writes)
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

---

## 4. Derived Expressions: memo vs getter

A key design of Fict is: **Automatic Classification of Derived Expressions**.

### 4.1 Classification Rules

All expressions dependent on `$state` (directly or indirectly) are collected and then classified by usage:

1. **Used in JSX or `$effect`**
   → Compile to **memo node (derived signal)**

2. **Used only in events / plain functions**
   → Compile to **on-demand getter**

3. **Used in both**
   → Compile to memo, event reads current memo value

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

### 4.3 Example: Used Only in Event → getter

```ts
let count = $state(0)
const doubled = count * 2

const onClick = () => {
  console.log(doubled)
}
```

Conceptually becomes after compilation:

```ts
const $doubled = () => $count.get() * 2
const onClick = () => {
  console.log($doubled())
}
```

No resident memo node is established; instead, it is calculated on demand when the event occurs.

**This is the core mechanism ensuring "events always read the latest value".**

---

## 5. Fine-grained DOM pipeline (preview)

The compiler refactor described in [`docs/compiler-fine-grained-plan.md`](./compiler-fine-grained-plan.md) is landing in phases. As of the current build:

- Runtime helper layer (`bindText`, `bindClass`, `bindStyle`, `moveMarkerBlock`, `createVersionedSignal`, etc.) is in place.
- Fine-grained runtime execution is **the only mode**; `render()` annotates the container with `data-fict-fine-grained="1"` for debugging and monitoring.
- End-to-end scenarios (counter, keyed lists, nested conditionals, primitives) verify the fine-grained implementation.
- The compiler work (IR + JSX subset) is documented in [`docs/fine-grained-jsx-subset.md`](./fine-grained-jsx-subset.md) and [`docs/fine-grained-ir.md`](./fine-grained-ir.md).

Legacy mode infrastructure was removed on 2025-12-05; the architecture is now fully unified around fine-grained updates.

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

### 7.2 Scheduling Priority (fict/plus)

- `transition(fn)`: Low priority, interruptible, suitable for page transitions
- `task(fn, { timing: 'layout' })`: Execute before browser layout
- `task(fn, { timing: 'idle' })`: Execute when browser is idle

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

If components execute only once, it's easy to fall into this trap:

```ts
let count = $state(0)
const doubled = count * 2

const click = () => {
  alert(doubled) // In many frameworks, this is actually the "value at definition time"
}
```

Fict prevents this via the hard rule "**Event Scenario Derivation → getter**".

To summarize:

- Derived used only in JSX / `$effect` → memo (reactive binding)
- Derived used only in events / plain functions → getter (calculated at call time)
- Used in both → memo, event reads current memo value

This matches developer intuition while avoiding component re-execution.

---

## 10. Advanced: $store / resource / Escape Hatches (Conceptual)

This part covers advanced capabilities that might appear in `fict/plus` in the future, not part of the minimal mental surface area.

### 9.1 $store: Path-level reactivity

`$store` enables fine-grained tracking of nested property access:

```ts
import { $store } from 'fict/plus'

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
import { resource } from 'fict/plus'

const userResource = resource((id: string) => ({
  key: ['user', id],
  fetch: ({ signal }) => fetch(`/api/user/${id}`, { signal }).then(r => r.json()),
  staleTime: 10_000,
}))

function User({ id }: { id: string }) {
  const user = userResource.read(id)
  return <div>{user.name}</div>
}
```

- Handles caching, deduplication, cancellation, error boundaries.
- Can be used with Suspense / streaming SSR.

### 9.3 Escape Hatches: noTrack / "use no memo"

For areas that cannot be statically analyzed or where dependency collection is not desired, tracking can be explicitly turned off:

```ts
import { noTrack } from 'fict/plus'

$effect(() => {
  noTrack(() => {
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

### 9.4 Error boundaries (Planned)

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
- **Value Proxy**: A reactive wrapper that always reads from the live signal
- **DOM Markers**: `start`/`end` comment nodes defining block boundaries
- **Root Context**: Preserved across updates to maintain component lifecycle

When the list updates:

1. **Unkeyed lists**: Items with different references are destroyed and remounted (destructive update)
2. **Keyed lists**: Items are matched by key, signals are updated, and DOM is patched in-place (preserving identity)

### 10.2 Primitive Value Proxies

#### Behavior

Each keyed block wraps its item value in a proxy that:

- For **objects**: Transparently forwards all property access to the live signal value
- For **primitives** (number, string, boolean, etc.): Implements `Symbol.toPrimitive`, `valueOf`, `toString`, and exposes native prototype methods

This ensures that code like `item.toFixed(2)` or `item.toLowerCase()` works naturally.

#### ⚠️ Important Limitations

**DO NOT rely on type checks:**

```ts
createList(
  () => [1, 2, 3],
  item => {
    // ❌ Wrong - Returns 'object', not 'number'
    if (typeof item === 'number') {
    }

    // ❌ Wrong - Reference inequality
    if (item === 1) {
    }

    // ✅ Correct - Coercion triggers proxy
    if (item == 1) {
    }
    if (Number(item) === 1) {
    }

    // ✅ Correct - Use prototype methods naturally
    const formatted = item.toFixed(2) // Works!
  },
  item => item,
)
```

**Rationale**: This trade-off preserves the natural JavaScript API for primitives while maintaining reactivity. The alternative (creating new primitives on each read) would break reference equality everywhere and lose reactivity.

#### Helper Function (Optional)

For advanced use cases requiring the raw value:

```ts
import { unwrapPrimitive } from 'fict/runtime'

const rawValue = unwrapPrimitive(item) // Returns actual primitive
```

### 10.3 Keyed Blocks Always Rerender

#### Current Behavior

When a keyed list updates, **all matched blocks execute `rerenderBlock`** even if their value and index are unchanged.

```ts
const items = [
  { id: 1, name: 'Alice' },
  { id: 2, name: 'Bob' },
  { id: 3, name: 'Charlie' },
]

// Later: Only item 2 changed
setItems([
  items[0], // Same reference
  { ...items[1], name: 'Robert' }, // New reference
  items[2], // Same reference
])

// Current: All 3 items rerender
// Rationale: Guarantees effects/DOM stay synchronized
```

#### Why This Design?

1. **Same-reference mutations are detectable**: If `items[0]` is mutated in-place, the rerender ensures effects see the new values
2. **Effects always run**: `createEffect` subscriptions inside blocks are guaranteed to see updates
3. **Version bumping works**: When value reference is identical, `versionSig` is bumped to trigger proxy reads

#### Performance Considerations

For **large lists (100+ items)** with frequent updates, this can be expensive. Mitigation strategies:

1. **Use immutable updates**: Only changed items should have new references
2. **Memoize expensive renders**: Wrap list items in `memo()` components
3. **Virtual scrolling**: Only render visible items
4. **Optimize `rerenderBlock` fast paths**: The runtime tries to patch text/elements in-place when possible

#### Example: Optimizing Large Lists

```tsx
// ❌ Potentially slow for large lists
createList(
  () => hugeArray, // 1000+ items
  item => <ExpensiveComponent item={item} />,
  createElement,
  item => item.id,
)

// ✅ Better: Memoize expensive components
const MemoizedItem = memo(ExpensiveComponent)
createList(
  () => hugeArray,
  item => <MemoizedItem item={item} />,
  createElement,
  item => item.id,
)

// ✅ Best: Virtual scrolling for very large lists
createList(
  () => visibleItems, // Only render visible slice
  item => <Item item={item} />,
  createElement,
  item => item.id,
)
```

#### Future: Configurable Strategy?

A potential future enhancement could add an option:

```ts
createList(items, renderItem, createElement, getKey, {
  rerenderStrategy: 'always' | 'on-change', // Default: 'always'
})
```

Where `'on-change'` would skip rerender when `value` and `index` are unchanged. However, this requires users to guarantee immutable updates or manually trigger version bumps for mutations.

### 10.4 Primitive Proxies Are Internal Only

#### Scope

The `PRIMITIVE_PROXY` symbol is recognized by `createElement` **only during keyed-block mounting**. This is an internal implementation detail.

#### ⚠️ Do Not Use Outside Lists

```ts
// ❌ Wrong - Won't update reactively
const count = createSignal(0)
const proxy = createValueProxy(() => count())
return createElement(proxy)  // Creates static text node!

// ✅ Correct - Use standard bindings
const count = createSignal(0)
return <div>{count}</div>  // Uses reactive text binding
```

**Rationale**: Primitive proxies are designed specifically for the keyed-list update flow. Using them elsewhere bypasses the standard binding system and creates non-reactive DOM.

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

## 11. DevTools Specification (Draft)

### Core Features

1. **Dependency Graph Viewer**
   - Visualize: Sources → Memos → Effects/Bindings
   - Click any node to see its dependencies and dependents

2. **"Why did this update?" Panel**
   - Select any DOM element or effect
   - Shows the chain: which $state changed → which memos recomputed → this update

3. **Update Timeline**
   - Flame graph of updates over time
   - Highlight "hot" nodes (frequent recomputation)

4. **Warnings Panel**
   - "This memo is coarse-grained because of dynamic key access"
   - "This function was treated as a black box"
   - Click to jump to source location

5. **State Inspector**
   - View current values of all $state
   - Edit values to test reactivity

---

## 12. Technical Risks and Boundaries

To fully land this set of things in reality, there are still many hard problems to solve:

- Static analysis only works for a "reasonable subset" of JS; extremely dynamic code needs to fall back to conservative mode;
- Deep reactivity ($store) requires careful shape analysis and Proxy overhead trade-offs;
- Dependency boundaries of async effects, race condition cancellation, and behavior under SSR/Hydration need to be very clear;
- When compiled code differs significantly from source code, debugging experience relies on high-quality source maps and DevTools.

Fict's current stage is more like:

> "We design a set of **Fiction-first + Compiler-driven** UI semantics clearly,
> and then prove the engineering feasibility of this design through iteration."

If you are interested in these low-level details, welcome to participate directly in the implementation, or challenge the semantic design itself in issues.

---

## 13. Summary

- Fict's goal is not to "reinvent another framework that looks like React", but:
  - To let you write the **story the user sees** in TypeScript that is close to pseudocode;
  - To hand over complex reactive wiring and performance optimization to the compiler and runtime;
  - To retain the engineering advantages brought by TSX and existing toolchains.

- From an architectural perspective, it stands on the shoulders of several predecessors:
  - React Compiler's automatic derivation idea
  - Solid's fine-grained reactive graph
  - Svelte 5 / Vue's intuitive mutable syntax
  - Plus a little bit of **"UI is fiction over real state"** paranoia.
