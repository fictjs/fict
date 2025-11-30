# Fict Compiler Spec (Draft)

> This document is a "trial specification" for the Fict compiler: you can use it as a reference blueprint when implementing TS transform / SWC plugins.

Goal:
Given a piece of TSX source code, the Fict compiler needs to:

1. Find all `$state` declarations (signal sources)
2. Infer all derived expressions dependent on `$state`
3. Identify dependencies in `$effect` and JSX dynamic bindings
4. Build a minimized, glitch-free dependency graph
5. Generate corresponding runtime calls (state/memo/effect/binding)
6. Conservatively downgrade and issue compilation warnings where semantics are uncertain

This specification uses a set of "Rules A–L" to describe the entire process.

---

## 0. Terminology

- **Source**: Reactive source (signal) produced by `$state` declaration.
- **Derived**: Expression dependent on Source (directly or indirectly).
- **Effect**: Side-effect node declared by `$effect`.
- **Binding**: Dynamic attribute / children update function in JSX.
- **Region**: A group of Derived expressions closely related in terms of control flow/scope.
- **IR (Intermediate Representation)**: Abstract structure used internally by the compiler, not directly exposed to user code.

---

## 1. Rule A: Identify `$state` Sources

### Syntax Form

```ts
let x = $state(42)
const y = $state({ foo: 1 })
```

Constraints:

* `$state` must be imported from `'fict'` (or subsequent official packages).
* Calls must appear at the top level of a module / component function body.
* `$state` is not allowed in loops or conditions (if present -> compilation error or strong warning).

### Compilation Behavior

1. Assign a unique ID (e.g., `s1`, `s2`) to each `$state` call.

2. Create `SourceNode` in IR:

   ```ts
   interface SourceNode {
     id: string      // "s1"
     name: string    // Source variable name: x
     type: 'state'
     initial: ASTNode
     scope: ScopeId
   }
   ```

3. Record all **read/write positions** for that variable:

   * Read: Appears as part of an expression (`x + 1`, `foo(x)`, etc.)
   * Write: Assignment / Increment / Decrement / Compound Assignment (`x = ...`, `x++`, `x += 1`, etc.)

4. Generate runtime initialization code (conceptually):

   ```ts
   const $__s1 = createState(42)
   // All reads/writes of x are rewritten as $__s1.get() / $__s1.set(...)
   ```

   Actual implementation will combine SSA/control flow for smarter rewriting, rather than simple replacement.

---

## 2. Rule B: Collect Derived Expressions

### What is Derived?

Any expression `E` that satisfies:

* Directly or indirectly reads a `$state` variable (`SourceNode`);
* And `E` is not at the outermost layer of an `$effect` call (effects are counted separately);

For example:

```ts
const subtotal = price * quantity
const label = `${user.firstName} ${user.lastName}`
const canSubmit = formValid && !submitting
```

The compiler needs to:

1. Assign `DerivedNode` for each such expression:

   ```ts
   interface DerivedNode {
     id: string      // "d1"
     ast: ASTNode    // AST of the corresponding expression
     scope: ScopeId
     sources: SourceNode[]   // Direct dependencies
     derivedDeps: DerivedNode[] // Indirect dependencies
     usages: UsageSite[]     // JSX / effect / event / etc.
   }
   ```

2. Fill `sources` and `derivedDeps` through one or more graph traversals.

---

## 3. Rule C: Select memo / getter based on usage type

Each `DerivedNode` will be used several times in the source code. Usage types include:

* `JSXBinding`: Used in JSX attributes/children
* `EffectUsage`: Read in `$effect` function body
* `EventUsage`: Used in JSX event handlers (e.g., `onClick` closure)
* `PlainUsage`: Used in other plain functions / plain closures

### Decision Logic

For each `DerivedNode`:

1. If `JSXBinding` or `EffectUsage` exists:
   → Compile as **memo node** (`MemoNode`), cache maintained by runtime.

2. Otherwise (no JSX / Effect usage):
   → Compile as **on-demand getter**.

**Special: When both memo usage and event usage exist**

* Still compile as memo.
* Reads in events become "read current memo value".

### Example 1: Bind only to JSX

```ts
const total = price * quantity
return <div>{total}</div>
```

* `total` only has `JSXBinding` usage → memo.

### Example 2: Use only in events

```ts
const doubled = count * 2
const click = () => console.log(doubled)
```

* `doubled` only has `EventUsage` → getter.

### Example 3: Use in both

```ts
const doubled = count * 2

return (
  <>
    <div>{doubled}</div>
    <button onClick={() => console.log(doubled)} />
  </>
)
```

* → memo + event reads current memo value.

---

## 4. Rule D: Control Flow Region Grouping

### Problem

The following code:

```ts
const count = videos.length
let heading = emptyHeading
let extra = 42

if (count > 0) {
  const noun = count > 1 ? 'Videos' : 'Video'
  heading = `${count} ${noun}`
  extra = computeExtra()
}
```

If we build memos for `heading` and `extra` separately, it leads to:

* Duplicate calculation of `count`
* Duplicate evaluation of if conditions
* Logic fragmentation

### Strategy: Build **Region**

1. Find the AST subtree containing all Derived expressions, assignments, and supporting control flow (`if` / `switch` / `for`).

2. Through static analysis, aggregate them into a **Minimal Enclosed Region** `Region`:

   * Variables before entering Region (e.g., `videos`, `emptyHeading`) as input;
   * Region internally freely uses local variables, control flow;
   * Region outputs several derived results (e.g., `heading`, `extra`).

3. Create a `MemoNode` for the entire Region, returning an object or tuple:

   * `{ heading, extra }` or `[heading, extra]`

### Compilation Illustration

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

const { heading, extra } = $viewState()
```

This way:

* Logic stays together (readable)
* Only one memo (maintainable)
* Reasonable performance (avoids duplicate calculation)

---

## 5. Rule E: Props Destructuring and Default Values

### Source Code

```ts
interface Props {
  name: string
  age?: number
  onClick: (id: string) => void
}

export function Greeting({ name, age = 18, onClick }: Props) {
  const label = `${name} (${age})`
  return <button onClick={() => onClick(name)}>{label}</button>
}
```

### Compilation Target

* For the user, this is normal TS destructuring;
* For Fict, it needs to maintain tracking of the original `props` source.

### Processing Steps

1. "Desugar" destructuring in function parameters into internal variable bindings, and keep a `props` source reference (visible only during compilation).

   Conceptually:

   ```ts
   function Greeting($__props: Props) {
     const name = $__props.name
     const age = $__props.age ?? 18
     const onClick = $__props.onClick
     // ...
   }
   ```

2. Trace read/write behavior of `name` / `age` / `onClick` back to the `__props` source:

   * If props change at the runtime layer (e.g., parent component state change), memo / effect / binding can track the latest value.

3. Do not expose `__props` at the type level, keeping the IDE experience natural.

---

## 6. Rule F: JSX Dynamic Binding

For each JSX element:

```tsx
<button disabled={!isValid} onClick={submit}>
  {label}
</button>
```

The compiler will:

1. Generate an "instance structure" for that element:

   * Native DOM creation logic
   * Dynamic binding list

2. Create `BindingNode` for each dynamic position:

   ```ts
   interface BindingNode {
     id: string
     kind: 'prop' | 'child' | 'event'
     elementId: ElementId
     updateFn: (value: any) => void
     deps: (SourceNode | MemoNode)[]
   }
   ```

3. In runtime:

   * When `deps` change, call `updateFn` to perform DOM operations.

---

## 7. Rule G: $effect Dependencies and Lifecycle

### Source Code

```ts
$effect(() => {
  document.title = `Count: ${count}`
})
```

### Compilation Behavior

1. Collect dependencies used in the effect function body (read `$state` and memo).

2. Create `EffectNode`:

   ```ts
   interface EffectNode {
     id: string
     deps: (SourceNode | MemoNode)[]
     fn: () => void | (() => void | Promise<void>)
   }
   ```

3. Runtime semantics:

   * First mount: Execute `fn` once, record returned cleanup (if any).
   * When any `deps` change:

     1. Call previously recorded cleanup (if any)
     2. Execute `fn` again, record new cleanup

### Async Effect

```ts
$effect(async () => {
  loading = true
  const res = await fetch(url)
  data = await res.json()
  loading = false
})
```

Rules:

* Dependency collection only happens during the "initial synchronous execution phase", i.e., parts before `await`;
* Reads after `await` will not append dependencies (consistent with most frameworks);
* If precise control of async lifecycle is needed, rewrite to explicit cleanup pattern.

---

## 8. Rule H: Conservative Downgrade and Warning

For the following cases where the compiler cannot safely perform fine-grained analysis, fallback to conservative mode:

* Dynamic property access: `obj[key] = value`, where `key` comes from runtime.
* Passing to black-box functions: `thirdPartyMutation(user)`, which might modify the object arbitrarily.
* Using highly dynamic language features like `eval` / `with` / `Proxy`.

Strategy:

1. **Conservative Subscription**: Establish coarse-grained subscription to the entire object / larger scope state.
2. **Compilation Warning**: Output explanation in dev mode:

   * "Dependency scope widened due to dynamic path access here"
   * "This function call is treated as a black box, may cause over-recomputation"

Developers can locally turn off Fict's smart behavior via escape hatches like `noTrack` / `"use no memo"`.

---

## 9. Rule I: Cross-Module Derivation

When a derived value is defined in module scope and used across modules:

```ts
// store.ts
export let count = $state(0)
export const doubled = count * 2

// A.ts
import { doubled } from './store'
$effect(() => console.log(doubled))

// B.ts
import { doubled } from './store'
const click = () => console.log(doubled)
```

To ensure consistency:

* Module-level derivation **always compiles to memo**;

* Exported as a getter:

  ```ts
  const $__doubled = createMemo(() => $__count.get() * 2)
  export const doubled = { get value() { return $__doubled() } }
  // Or export function directly: export const doubled = () => $__doubled()
  ```

* When reading at import side:

  * In JSX / effect: Use as memo node;
  * In event / function: Read latest value.

---

## 10. Rule J: Lazy Evaluation of Conditional Derivation

Typical scenario:

```ts
const heavy = expensiveComputation()
const show = someFlag

if (show) {
  return <HeavyPanel data={heavy} />
}
```

Optimization Strategy (Optional):

* If `heavy` is only used within the Region where `show` is `true`, and there are no other usages;

* Condition can be inlined in memo:

  ```ts
  const $viewState = createMemo(() => {
    if (!show) return { show: false, heavy: null }
    return { show: true, heavy: expensiveComputation() }
  })
  ```

* Prevent calculating `expensiveComputation()` when `show === false`.

This is a "good but not mandatory" optimization, which can be part of subsequent iterations.

---

## 11. Rule K: Circular Dependency Detection

Fict must prevent cycles between derivations:

```ts
let a = $state(0)
const b = a + c
const c = b + 1
```

Handling:

1. After building the `DerivedNode` graph, run topological sort:

   * Detect if a cycle exists.
2. If a cycle exists:

   * Compilation error, pointing out relevant expression locations.
   * Hint error message as: "Detected cyclic derived dependency between X and Y".

---

## 12. Rule L: Getter Cache within Same Synchronous Block

When a getter-derived is used multiple times within the same synchronous execution block:

```ts
const click = () => {
  console.log(expensive)
  console.log(expensive)
}
```

The compiler can rewrite it as:

```ts
const click = () => {
  const __exp = $expensive()
  console.log(__exp)
  console.log(__exp)
}
```

Avoid duplicate calculation. This can be part of compilation optimization without affecting semantics.

---

## 13. Rule M: Deep Modification Warning

For objects/arrays declared with `$state`, if deep property assignment is detected:

```ts
let user = $state({ addr: { city: 'London' } })
user.addr.city = 'Paris'  // ⚠️ Compilation Warning
```

Compiler should:
1. Output warning: "Direct mutation of nested property won't trigger update. Use spread or $store."
2. Give correction suggestion: `user = { ...user, addr: { ...user.addr, city: 'Paris' } }`

---

## 13. Compilation Pipeline Overview

1. **Parse + Type Check (Handled by TS / SWC)**
2. **Mark Imports: Identify `$state`, `$effect`, (future `$store`, `resource`, etc.)**
3. **Build Scope Info** (Function, Block, Module)
4. **Scan `$state`** → Generate `SourceNode` set
5. **Static Data Flow Analysis**:

   * Mark expressions dependent on `SourceNode` → `DerivedNode`
   * Identify `$effect` / JSX dynamic bindings → usage list
6. **Build Dependency Graph**:

   * `SourceNode → DerivedNode → Effect/Binding`
   * Handle cross-module memo
   * Apply Region grouping (control flow)
7. **Apply Rules C–L**:

   * Classify memo / getter
   * Control flow grouping
   * Cycle detection
   * Conservative downgrade & Warning
8. **Generate Runtime Call IR**:

   * Similar to: `createState`, `createMemo`, `createEffect`, `createBinding`, etc.
9. **IR → JS Output**:

   * Generate final code according to target runtime API (`@fict/runtime`)

---

## 14. Boundaries: When "Not To Be Smart"

Fict's principle is:

> **Be as smart as possible where semantics are certain; once uncertain, choose to be honest and loud.**

Therefore:

* If you write unconventional/highly dynamic code, Fict will:

  * Guarantee semantic correctness as much as possible (no random optimizations)
  * Tell you via warning "I can only be crude here"
* If you want to completely turn off analysis for a file/function:

  * You can use escape hatches like `// "use no memo"` or `noTrack`.

This Spec itself will be constantly corrected with implementation:
**The final criterion is the balance of "User Intuition + Implementability + Performance".**

