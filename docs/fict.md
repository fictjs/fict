# Fict – A compiler that makes JavaScript variables automatically reactive

Fict Repo - https://github.com/fictjs/fict

## Opening: A Starting Point for Technical Exploration

When developing with React, we often write code like this:

```jsx
const [count, setCount] = useState(0)
const doubled = useMemo(() => count * 2, [count])
const handleClick = useCallback(() => setCount(c => c + 1), [])
```

The meaning expressed by these three lines is actually quite simple: `count` is a number, and `doubled` is twice its value.

This raises a question: **Is it possible for a compiler to automatically infer these dependencies?**

Modern compilers are already capable of analyzing control flow, performing type inference, and eliminating dead code—theoretically, automatically tracking variable dependencies seems feasible as well.

Fict is a technical exploration based precisely on this idea.

---

## Part 1: Core Design Philosophy

### What if variables just... worked?

The core hypothesis of Fict is:

**If the compiler can see your code, it can know which variables depend on which other variables.**

Let's look at an example:

```jsx
function Counter() {
  let count = $state(0) // Marker: This is mutable state (reactive source)
  const doubled = count * 2 // Compiler inference: Depends on count
  const message = `Value: ${doubled}` // Compiler inference: Depends on doubled → Depends on count

  return <button onClick={() => count++}>{message}</button>
}
```

Notice what is **missing** here:

- No `setCount` (direct assignment)
- No `useMemo` (automatic inference)
- No dependency arrays (compiler analysis)
- No `.value` or explicit getter calls (just plain variables)

`$state(0)` is the only marker. Everything else is inferred by the compiler itself.

### Technical Feasibility Analysis

This isn't magic; it's based on mature static analysis technology.

The compiler constructs a High-Level Intermediate Representation (HIR, a high-level IR) and performs data flow analysis; with the right representation, dependency tracking turns into a "traversing the dependency graph" problem.

In a simplified SSA (Static Single Assignment) perspective, you would see a dependency chain like this:

```
count_1    = $state(0)                 // Reactive source
doubled_1  = count_1 * 2               // Uses count_1 → Depends on count
message_1  = `Value: ${doubled_1}`     // Uses doubled_1 → Transitive dependency on count
```

The compiler knows `message` depends on `count` without you telling it.

> The above is an overview of Fict's core design philosophy and technical route. Subsequent chapters will detail the specific implementation methods.

---

## Part 2: Comparison with Other Frameworks

### 2.1 Syntax Comparison

Let's look at how different frameworks handle the same problem:

```
┌─────────────────────────────────────────────────────────────┐
│ React                                                       │
├─────────────────────────────────────────────────────────────┤
│ const [count, setCount] = useState(0)                       │
│ const doubled = useMemo(() => count * 2, [count])           │
│ // Problem: Manual dependency arrays are error-prone;       │
│ // React Compiler automates memoization.                    │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ Solid                                                       │
├─────────────────────────────────────────────────────────────┤
│ const [count, setCount] = createSignal(0)                   │
│ const doubled = createMemo(() => count() * 2)               │
│ // Mental model: count vs count();                          │
│ // Destructuring props might lose reactivity (use splitProps)│
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ Svelte 5                                                    │
├─────────────────────────────────────────────────────────────┤
│ let count = $state(0)                                       │
│ let doubled = $derived(count * 2)                           │
│ // Better, but derived intent still needs explicit $derived │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ Fict                                                        │
├─────────────────────────────────────────────────────────────┤
│ let count = $state(0)                                       │
│ const doubled = count * 2                                   │
│ // No $derived: Compiler automatically infers within static │
│ // analysis scope.                                          │
└─────────────────────────────────────────────────────────────┘
```

---

### 2.2 Compiler Comparison

Syntax is just the surface difference. A more essential distinction lies in: **What responsibilities do the compilers (or runtimes) of each framework assume?**

---

#### React Compiler: Automatic Memoization (Does not change React Model)

The goal of React Compiler is clear: **Automatic memoization**.

Its output often "looks like" it automatically added `React.memo / useMemo / useCallback` for you, but implementation-wise, it doesn't necessarily generate these Hook calls; in public discussions, React Compiler explicitly stated it directly inlines dependency checks and caches values, avoiding the overhead of closures and dependency arrays associated with handwritten `useMemo/useCallback`.

```jsx
// Input
function Component({ items }) {
  const sorted = items.toSorted()
  return <List data={sorted} />
}
```

You can understand the compiler's "conceptual" output as:

```jsx
// Conceptual equivalent (for understanding, not necessarily actual output)
function Component({ items }) {
  const sorted = useMemo(() => items.toSorted(), [items])
  return <List data={sorted} />
}
```

**What it does:**

- ✅ Automatic memoization: Caches calculation results, stabilizes references, reduces unnecessary re-computations and re-renders.
- ✅ Skips as many updates as possible without changing React's render + reconciliation model.
- ✅ Still allows developers to use `useMemo/useCallback` as escape hatches (e.g., for stable effect dependencies).
- ✅ Provides `"use no memo"` as a temporary escape hatch: lets a specific function completely skip compiler optimization for troubleshooting incompatible code.

**What it doesn't do:**

- ❌ Does not turn React into a "compile to fine-grained DOM instructions" framework: React is still render + reconciliation (colloquially "VDOM + diff").
- ❌ Does not replace the hooks system: You still write `useState/useEffect/...`. The compiler just tries to automate "caching work" like memoization.

React Compiler's design positioning is: **Improve performance through automatic memoization without changing the logical model of React**.

---

#### Svelte 5: Template Compilation + Explicit Runes (Derivations/Side Effects capture dependencies at evaluation)

Svelte's typical path is: **Compile templates to DOM update code** (no VDOM), and use runes (`$state/$derived/$effect`) to explicitly write out the intent of "this is state/derived/side-effect".

The key point: Svelte 5's `$derived` documentation clearly states dependency rules—**any value read synchronously inside a `$derived` expression (or `$derived.by` function body) becomes a dependency**; when dependencies change, it is marked dirty and re-calculated on next read.
`$effect` similarly schedules updates based on dependency changes.

```svelte
<script>
  let count = $state(0)
  let doubled = $derived(count * 2)
</script>

<button on:click={() => count++}>
  {doubled}
</button>
```

**What it does:**

- ✅ Template → DOM update code (no VDOM)
- ✅ Runes provide explicit semantics: `$derived` for derivations, `$effect` for side effects, dependencies captured at evaluation and schedule updates.

**What it doesn't do:**

- ❌ Does not do global SSA-level automatic derivation inference for "arbitrary JS blocks" to let you skip `$derived`: In Svelte, derivation intent still needs to be expressed via `$derived`.
- ❌ UI components are still organized around `.svelte` files (this is its ecosystem & DX choice).

---

#### Solid: Compile-time JSX lowering / JSX compilation + Runtime Fine-grained Dependency Tracking (No VDOM)

Solid's route is more like: **Compiler is responsible for turning JSX into efficient DOM creation/binding**, while dependency tracking and update scheduling mainly happen at runtime (signals/memos/effects).

Solid official documentation clearly warns: **Direct destructuring of props is not recommended**, as it may break reactivity; need to use `props.xxx`, wrapper functions, or `splitProps`.
Meanwhile, Solid's homepage explicitly emphasizes: **No Virtual DOM / no extensive diffing**, updates can be precise to the DOM binding layer.

```jsx
function Counter() {
  const [count, setCount] = createSignal(0)
  const doubled = createMemo(() => count() * 2)
  return <button onClick={() => setCount(c => c + 1)}>{doubled()}</button>
}
```

**What it does:**

- ✅ JSX → DOM templates/bindings (static optimization at compile time)
- ✅ Runtime fine-grained dependency tracking: Whoever uses the signal subscribes to it; only updates relevant DOM bindings when changed (no VDOM).
- ✅ Provides tools (like `splitProps`) to safely handle props (avoiding loss of reactivity on destructuring).
  **What it doesn't do:**

- ❌ No "automatic derivation inference": Derived values usually need explicit `createMemo`.
- ❌ Runtime model is "signals driven", not "compiler globally infers everything".

---

#### Vue Vapor: A "No VDOM" Exploration Direction (Still Evolving)

In Vue's official documentation, Vapor Mode is described as **a new compilation strategy being explored**: inspired by Solid, **not relying on Virtual DOM**, and making stricter use of Vue's built-in reactivity system.
Meanwhile, the `vue-vapor` repository itself is in an archived (read-only) state, so it should be treated as experimental / in flux.

---

### Compiler Comparison Table (Stricter Version)

> Note: ✅ = Officially clearly described and presented as a stable capability; 🧪 = Officially defined as exploration/experimental direction; — = Not the main narrative of the framework/hard to draw a hard conclusion.

| Dimension                                  | React + React Compiler                                                                                          | Svelte 5                                                                                            | Solid                                                    | Vue Vapor                                                                                                       | Fict        |
| :----------------------------------------- | :-------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------- | :------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------- | :---------- |
| Automatic memoization (reduce manual memo) | ✅ Automatic memoization, `useMemo/useCallback` as escape hatch; supports `"use no memo"` to skip optimization. | ❌ Derivations need explicit `$derived`.                                                            | ❌ Derivations usually need `createMemo` (explicit).     | —                                                                                                               | ✅          |
| Still render + reconciliation?             | ✅ Yes.                                                                                                         | ❌ (Template compiled to DOM updates)                                                               | ❌ (No VDOM/No diffing)                                  | 🧪 Official exploration of "No VDOM" strategy.                                                                  | ❌          |
| Are Derived/Side-effect intents explicit?  | ✅ Hooks explicit; memoization can be automated by compiler.                                                    | ✅ `$derived/$effect` explicit; dependencies are captured from synchronous reads during evaluation. | ✅ Explicit memo/effect; dependency tracking at runtime. | ✅ (Vue default: computed/watch etc.; Vapor's commitment to not changing intent expression is not set in stone) | ✅          |
| DX Form                                    | JS/JSX + Compiler                                                                                               | `.svelte` + runes                                                                                   | JS/JSX + signals                                         | SFC/Template-centric (Vapor is exploration)                                                                     | Pure JSX/JS |

---

## 2.3 Execution Model Comparison

The compiler is only half the story; the other half is the execution model.

| Framework             | Does Component Code Re-execute?                                                                       | Update Granularity                                        | Control Flow Expression                              |
| :-------------------- | :---------------------------------------------------------------------------------------------------- | :-------------------------------------------------------- | :--------------------------------------------------- |
| React (with Compiler) | React still re-renders; the compiler memoizes values/functions to reduce work and stabilize props.    | Component/Subtree dominant (determined by reconciliation) | Native JS (if/for)                                   |
| Solid                 | Executes once on init; subsequent fine-grained updates driven by signal subscriptions (no VDOM/diff). | DOM Binding Level                                         | Commonly uses `<Show>/<For>` control flow components |
| Svelte 5              | Executes once on init; `$derived/$effect` scheduled on dependency change.                             | DOM update code + runes scheduling                        | Template blocks (`{#if}/{#each}`)                    |
| Vue Vapor             | 🧪 Exploring: Goal is rendering path not dependent on VDOM.                                           | 🧪                                                        | Template/Directives centric                          |
| Fict                  | Run once + reactive bindings                                                                          | Fine-grained DOM update                                   | Native JS (if/for)                                   |

### An Intuitive Example: Re-execution Strategy and Slot Reuse

```jsx
function Demo() {
  console.log('mount once') // First run
  let count = $state(0)
  $effect(() => console.log('count changed', count))
  return <button onClick={() => count++}>{count}</button>
}
```

- After clicking the button, `mount once` will not repeat. Reactive updates are handled by bindings/effects, not by re-running the whole component body.
- DOM will not be recreated: Signal slot reuse + binding updates ensure the button node, events, and refs remain in place, only the text node updates.

---

## Part 3: Fict's "Full-Link Analysis" (Design Goal)

One thing Fict attempts to do is: **Analyze the entire JS function, not just the template part.**

```jsx
function Counter() {
  let count = $state(0)
  const doubled = count * 2
  const message = `Value: ${doubled}`

  if (count > 10) {
    return <Special value={message} />
  }
  return <button onClick={() => count++}>{message}</button>
}
```

Main processing stages of the Fict compiler:

1.  **Build HIR (High-Level Intermediate Representation)**: Function body → Basic Blocks + CFG (including if/for/while/switch)
2.  **Convert to SSA**: Make assignment versions unique, facilitating explicit dependency edges
3.  **Analyze Reactive Scopes**: Automatically turn expression regions dependent on `$state` into memo/effect/bindings
4.  **Detect Control Flow Reads**: When reactive values appear in branch tests, lower supported return branches into reactive conditionals
5.  **Generate Fine-grained DOM**: JSX → DOM instructions; Bindings → Precise effects

---

## Part 4: Fict's Mixed Execution Model

The execution model designed by Fict:

- If state is **only read in JSX** → only relevant DOM nodes update
- If state is **read in supported control-flow return branches** (e.g., sequential `if-return`, `switch-return`, equivalent `try` return branches) → compiler emits reactive branch bindings

The compiler analyzes and decides which update strategy to adopt at compile time. Developers don't need to rewrite code into special syntax like `<Show>/<For>` or `{#if}`; native `if/for` works directly.

#### Control-flow scopes and cleanup

- JSX-driven conditions/lists are automatically scoped: when a branch unmounts, its effects/memos are disposed.
- Simple plain `if` blocks that only set up reactive primitives are auto-wrapped with `runInScope` for cleanup when the condition flips.
- More complex plain JS control flow (nested conditionals/loops) is **still not auto-scoped**. Creating `createEffect/createMemo/createSelector` inside such blocks can leak unless you manage cleanup.
- The compiler now emits a warning (`FICT-R004`) when it sees these reactive primitives inside non-JSX control flow that cannot be auto-scoped.
- Use explicit scopes to manage lifetime:

```ts
import { createScope, runInScope, onCleanup } from 'fict'

// Manual scope
const scope = createScope()
scope.run(() => {
  /* createEffect/createMemo here */
})
onCleanup(scope.stop)

// Flag-driven scope
runInScope(
  () => show,
  () => {
    createEffect(() => {
      /* ... */
    })
  },
)
```

**Pitfall vs. fix**

```tsx
// 🚫 Not cleaned up when the condition flips
function Counter() {
  let count = $state(0)
  if (count > 0) {
    createEffect(() => console.log('count > 0:', count))
  }
  return <button onClick={() => count++}>Inc</button>
}

// ✅ Scoped by predicate
function CounterScoped() {
  let count = $state(0)
  runInScope(
    () => count > 0,
    () => {
      createEffect(() => console.log('count > 0:', count))
    },
  )
  return <button onClick={() => count++}>Inc</button>
}
```

---

## Part 5: How the Compiler Works

> The Fict compiler transforms source code into efficient runtime code through several core stages.

### Inside the compiler

Fict compiler's core is a multi-stage pipeline:

```
Plain JS/TS + JSX/TSX (compiled)
     ↓
  ┌─────────┐
  │  HIR    │  CFG (Basic Blocks + Control Flow Graph)
  └────┬────┘
       ↓
  ┌─────────┐
  │  SSA    │  Versioned Assignments + Dependency Analysis
  └────┬────┘
       ↓
  ┌─────────────────┐
  │ Reactive Scopes │  Reactive Scope Analysis + Region Grouping
  └─────────────────┘
       ↓
  ┌─────────┐
  │ Codegen │  Fine-grained DOM Operations + bindings
  └─────────┘
```

The compiler performs **Reactive Scope Analysis** to determine memoization boundaries, automatically identifying which expressions should be wrapped as memos, and their dependencies.

### HIR Construction (Schematic)

```js
if (count > 10) {
  return <Special />
}
return <Normal />

// HIR (Schematic)
Block 0:
  $0 = LoadLocal count
  $1 = BinaryExpr(>) $0, 10
  Branch $1 -> Block1, Block2

Block 1:
  $2 = JSXElement(Special)
  Return $2

Block 2:
  $3 = JSXElement(Normal)
  Return $3
```

### SSA Conversion & Dependency Tracking (Schematic)

```js
let x = count
if (cond) {
  x = count + 1
}
return x

// SSA (Schematic)
x_1 = count_1
Branch cond -> Block1, Block2

Block1:
  x_2 = count_1 + 1
  Jump -> Block3

Block2:
  Jump -> Block3

Block3:
  x_3 = Phi(Block1: x_2, Block2: x_1)
  Return x_3
```

Now the dependency relationship is very clear: `x_3` ultimately depends on `count_1`.

---

## Part 6: Compilation Output Example (Simplified)

```jsx
// Input
function Counter() {
  let count = $state(0)
  const doubled = count * 2
  return <button onClick={() => count++}>{doubled}</button>
}
```

```js
// Output (Simplified Schematic)
// User code stays ‘plain variables’; the generated code may use accessor calls internally.
function Counter() {
  const __ctx = __fictUseContext()

  // $state -> signal
  const count = __fictUseSignal(__ctx, 0, 0)

  // Derived value -> memo (Compiler inferred)
  const doubled = __fictUseMemo(__ctx, () => count() * 2, 1)

  // DOM Creation
  const button = document.createElement('button')
  const text = document.createTextNode('')
  button.appendChild(text)

  // Binding Update (Using fine-grained effect)
  bindText(text, () => doubled())

  // Event
  button.onclick = () => count(count() + 1)

  return button
}
```

The characteristics of this compilation output are:

- No VDOM
- No diffing
- Only precise DOM operations
- `doubled` automatically memoized

---

### Example with Control Flow

```jsx
// Input
function App() {
  let show = $state(true)
  if (show) return <Panel />
  return <Fallback />
}

// Output (Simplified)
function App() {
  const __ctx = __fictUseContext()
  const show = __fictUseSignal(__ctx, true, 0)

  // Supported control-flow return branches are lowered to reactive conditionals
  const binding = createConditional(
    () => show(),
    () => /* Panel's fine-grained DOM */,
    createElement,
    () => /* Fallback's fine-grained DOM */
  )
  __fictOnDestroy(() => binding.dispose())
  return binding
}
```

The conditional binding updates branch output when `show` changes, while signal slots are reused.

### Reactivity of Props

Fict automatically maintains the reactivity of props, even after destructuring:

```jsx
// Input
function Child({ count, update }) {
  const doubled = count * 2
  return <div>{doubled}</div>
}

// Output (Simplified)
function Child(__props) {
  const __ctx = __fictUseContext()

  // Destructured props automatically wrapped as getters
  const count = prop(() => __props.count)
  const update = __props.update // Function type not wrapped

  // Derived values automatically become memos
  const doubled = __fictUseMemo(__ctx, () => count() * 2, 0)

  // ...
}
```

This solves a common pain point in Solid: Destructuring props breaks reactivity. In Fict, you can destructure freely.

---

## Part 7: Compiler Safety Rails

### DX Protection Mechanisms

The Fict compiler detects common error patterns and issues warnings:

```
┌─────────────────────────────────────────────────────────────┐
│ Code       │ Issue                   │ Severity             │
├─────────────────────────────────────────────────────────────┤
│ FICT-C003  │ Nested Component Def    │ Warning              │
│ FICT-M003  │ Memo with Side Effects  │ Warning              │
│ FICT-S002  │ State passed as arg     │ Warning              │
│ FICT-J002  │ List missing key        │ Warning              │
│ FICT-E001  │ Effect no deps          │ Warning              │
│ FICT-C004  │ Component no return     │ Warning              │
├─────────────────────────────────────────────────────────────┤
│ $state inside condition | Not Allowed | Compile Error       │
│ $state inside loop      | Not Allowed | Compile Error       │
│ Destructuring $state    | Not Allowed | Compile Error       │
└─────────────────────────────────────────────────────────────┘
```

For example, defining nested components is a common anti-pattern:

```tsx
function Parent() {
  // ⚠️ FICT-C003: Components should not be defined inside another component
  function Child() {
    return <div>Child</div>
  }
  return <Child />
}
```

The compiler will warn you to move `Child` to module scope.

---

## Part 8: Trade-offs

### What Fict can't do (yet)

I want to be honest about Fict's limitations:

**1. Dependency tracking inside black-box functions may be incomplete**

```js
const result = someExternalLib.compute(() => count)
// Compiler cannot see inside compute callback, dependency tracking might be incomplete
```

Solution: The compiler issues a warning (FICT-S002); use explicit getters or `untrack`/manual memo boundaries.

**2. Dynamic property access is limited**

```js
const key = getDynamicKey()
const value = obj[key] // Compiler doesn't know what key is
```

Solution: Degrade to object-level subscription + warning.

**3. No Ecosystem**

This is common for new frameworks. No UI library, no complete SSR framework, no mature router. If you need to go to production today, Fict might not be the right choice.

**4. Execution Model needs learning**

Fict's execution model differs from React (see Section 2.3):

```tsx
console.log('A') // Executes once
let count = $state(0)
$effect(() => console.log('B', count)) // Runs when count changes
```

Developers from a React background might be confused: "Why doesn't A execute every time?" This requires understanding Fict's binding/memo graph model.

We will provide Fict DevTools to visualize these regions to aid debugging.

**5. Compiler Complexity**

Fict's compiler is much more complex than Solid's. More code means more potential bugs.

### Known Escape Hatches / Mitigation

- Explicit `$memo` / `$effect`: When automatic inference doesn't meet expectations, manually declare derivation or side-effect boundaries.
- `prop/mergeProps` helpers: Manually maintain reactivity when props access patterns are special.
- Control Flow Degradation: Scenarios that cannot be statically analyzed degrade to conservative reactive bindings / warnings, prioritizing correctness.

### Why I still think it's worth it

Despite all these trade-offs, I believe what we get in return is worth it:

- The amount of code developers write every day is reduced.
- Mental burden is reduced.
- Beginners don't need to understand "why do I have to write useMemo".

React Compiler proved that "letting the compiler take more responsibility" is the right direction. Fict just pushes this idea a bit further.

---

## Part 9: Extended APIs

Fict also provides some extended APIs to handle scenarios that automatic inference cannot cover:

- **`$store`**: For fine-grained reactivity of nested objects. `$store` is the recommended choice when path-level update tracking for deep objects is needed.
- **`$memo`**: Escape hatch for explicitly creating memos. Although the compiler automatically infers derived values, developers can also manually control memoization.
- **`$effect`**: Explicitly declare side effects.
- **ErrorBoundary / Suspense / Transitions**: For error handling, async loading, and priority scheduling.

> Fict's design philosophy is "reduce boilerplate + compiler automatic inference", these APIs serve as supplementary tools for advanced scenarios.

---

## Part 10: Why Now

The frontend framework field is undergoing some interesting changes:

1.  **React Compiler achieved automatic memoization**: Reduces the need for manual memo without changing the React model.
2.  **Signals proposal is advancing in TC39**: Although still in early stages, it reflects the community's focus on reactive primitives.
3.  **Svelte 5 makes derivation/side-effect intent more explicit via runes**, with clear dependency rules (sync read equals dependency).
4.  **Vue is officially exploring Vapor Mode**: A compilation strategy that doesn't rely on VDOM and utilizes built-in reactivity more.

In this context:

> Fict does not attempt to replace these excellent frameworks, but is a technical exploration: If we start from scratch based on these excellent frameworks, taking "compiler automatic dependency inference" as the core design principle, how far can we go?

---

## Conclusion: Welcome to Try

Fict is currently under active development.

```bash
npm install fict
```

The core compiler and runtime functions are basically stable, but the ecosystem is still under construction. If you are interested in trying it out, we look forward to your feedback:

- Bug reports (edge cases are especially valuable)
- Suggestions for improving compiler output
- Usage patterns you think should be supported but are not yet

Thank you for reading, and looking forward to communicating with you.
