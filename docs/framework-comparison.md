# Fict Framework Comparison Report

> **Context**: This report compares **Fict** with **React 19 + Compiler**, **SolidJS**, **Svelte 5.0+ (Runes)**, and **Vue 3.4 Vapor**, based on the provided `README.md`, `architecture.md`, and `compiler-spec.md`.

## 1. Executive Summary

**Fict** positions itself as a compiler-driven fine-grained reactive library
written in standard TSX. Its practical product claim is **React-like authoring
with a Solid-style dependency graph and compile-time reactivity guarantees**.
It is not positioned as the smallest runtime or as a benchmark-only Solid
replacement.

- **Core Innovation**: "Implicit Reactivity" via compilation. You write mutable JS code (`let x = $state(0); x++`), and the compiler automatically generates the signal graph.
- **Standout Feature**: **Automatic Derivation**. Unlike Svelte 5 (`$derived`) or Solid (`createMemo`), Fict automatically infers derived values and their dependencies.
- **Runtime Model**: **Compiler-first fine-grained execution**. Components execute once; supported control-flow return branches are lowered to reactive bindings, while normal JSX updates stay DOM-granular.

---

## 2. Technical Architecture Comparison

### 2.1 Reactivity & Rendering Model

| Feature                   | Fict                             | React 19 + Compiler    | SolidJS                           | Svelte 5 (Runes)        | Vue 3.4 Vapor           |
| :------------------------ | :------------------------------- | :--------------------- | :-------------------------------- | :---------------------- | :---------------------- |
| **Update Granularity**    | **Fine-grained (DOM Node)**      | Component-level (VDOM) | Fine-grained (DOM Node)           | Fine-grained (DOM Node) | Fine-grained (DOM Node) |
| **Component Execution**   | **Run once + reactive bindings** | Runs on every render   | Run Once (Setup)                  | Run Once (Setup)        | Run Once (Setup)        |
| **Virtual DOM**           | **None**                         | Yes                    | None                              | None                    | None (Vapor Mode)       |
| **Reactivity Primitives** | Implicit Signals (`$state`)      | Hooks (`useState`)     | Explicit Signals (`createSignal`) | Runes (`$state`)        | Refs (`ref`)            |

- **Fict vs React**: React relies on re-running components to detect changes (Diffing). The React Compiler optimizes _what_ needs to re-run (Memoization), while Fict updates through fine-grained bindings and branch-level conditionals.
- **Fict vs Solid**: Both build dependency graphs and run components once. Fict adds compiler lowering so mutable syntax (`count++`) and derived inference stay ergonomic.
- **Fict vs Svelte 5**: Both compile to fine-grained updates; Fict uses TSX and automatic derivation inference.

### 2.2 Compilation Strategy

- **Fict**:
  - **Automatic Derivation**: Derived values are memoized by default (unless `"use no memo"` disables it); events/plain closures read live values through getter rewrites.
  - **Control Flow Detection**: For supported control-flow return shapes (`if-return` / `switch-return` / equivalent `try` returns), the compiler emits reactive branch bindings. Simply defining a derived (`const x = signal * 2`) doesn't create branch bindings by itself.
  - **Control Flow Regions**: Compiles `if/for` blocks into a _single_ memoized "Region" that returns multiple values. This avoids the overhead of creating thousands of tiny memos for complex logic (a common issue in fine-grained reactivity).
- **React Compiler**: Automatically memoizes (`useMemo`/`useCallback`) to prevent unnecessary re-renders. It preserves the VDOM and component re-execution model.
- **Svelte 5**: Compiles `.svelte` files. Handles reactivity at the statement level. Components run once.
- **Vue Vapor**: Compiles templates into direct DOM manipulation code, bypassing the VDOM.

### 2.3 Runtime Size & Overhead

- **Fict**: ~10kb brotli compressed for the main package. Current
  js-framework-benchmark results are in the fine-grained tier, but the primary
  tradeoff is DX + strict guarantees rather than beating Solid on size or raw
  benchmark mean.
- **React**: Larger runtime (Scheduler, Reconciler, VDOM). ~50kb compressed.
- **Solid**: ~4.5kb brotli compressed. The smallest runtime among major frameworks.
- **Svelte**: Runtime is small, but code size can grow with component complexity (though Runes improves this).
- **Vue**: Larger runtime due to supporting Options/Composition API and legacy VDOM (unless using a Vapor-only build).

---

## 3. Developer Experience (DX) Comparison

### 3.1 Syntax & Boilerplate

**Scenario**: A counter where the value doubles and logs to the console.

**Fict**:

```tsx
export function Counter() {
  let count = $state(0) // Mutable source
  const doubled = count * 2 // Automatic derivation (no wrapper)

  $effect(() => console.log(`count=${count}`))

  return <button onClick={() => count++}>{doubled}</button>
}
```

**React 19**:

```tsx
export function Counter() {
  const [count, setCount] = useState(0)
  const doubled = count * 2 // Compiler automatically memoizes

  useEffect(() => console.log(count), [count]) // Compiler handles deps

  return <button onClick={() => setCount(c => c + 1)}>{doubled}</button>
}
```

**SolidJS**:

```tsx
export function Counter() {
  const [count, setCount] = createSignal(0)
  const doubled = () => count() * 2 // Explicit getter

  createEffect(() => console.log(count()))

  return <button onClick={() => setCount(c => c + 1)}>{doubled()}</button>
}
```

**Svelte 5**:

```svelte
<script>
  let count = $state(0);
  let doubled = $derived(count * 2); // Explicit derivation

  $effect(() => console.log(count));
</script>
<button onclick={() => count++}>{doubled}</button>
```

**Vue 3.4**:

```vue
<script setup>
import { ref, computed, watchEffect } from 'vue'
const count = ref(0)
const doubled = computed(() => count.value * 2)

watchEffect(() => console.log(count.value))
</script>
<template>
  <button @click="count++">{{ doubled }}</button>
</template>
```

**Analysis**:

- **Fict is the most concise**. It removes `setX`, `.value`, `() =>`, and even `$derived`.
- **Mental Model**: Fict allows "Plain JS" logic. You don't need to constantly think "is this a signal or a value?" like in Solid (function vs value) or Vue (`.value`).
- **Refactoring**: In Fict, changing a variable from a constant to `$state` doesn't require changing the syntax at usage sites (no need to add `()` or `.value` everywhere).

### 3.2 "Stale Closure" Issues

- **React**: Easy to get stale closures if dependencies are missed (though the Compiler fixes this).
- **Solid**: Solved by "functions everywhere", but easy to lose reactivity by destructuring props.
- **Fict**:
  - **Props**: Can be destructured (`{ name } = props`) while preserving reactivity (compiler magic).
  - **Events**: The "Automatic Getter" rule ensures that if a derived value is used in an event handler, it is compiled as a getter, so it always sees the latest value.
  - **Control Flow**: Supported return-branch control flow is lowered to reactive bindings, and closures/events read live getters, avoiding stale snapshots.

### 3.3 Control Flow

- **Fict**: Uses native `if`, `switch`, `map`.
  ```tsx
  {
    show && <Panel />
  }
  ```
- **Solid**: Prefers `<Show>`, `<For>` components to maintain fine-grained updates. Using `map` in Solid rebuilds DOM nodes unless carefully wrapped.
- **Svelte**: Uses template syntax `{#if} ... {/if}`.
- **Vue**: Uses directives `v-if`, `v-for`.
- **React**: Uses native JS.

**Winner**: Fict and React share the "Just JavaScript" advantage here. However, Fict's compiler optimizes these native flows into fine-grained updates, whereas React relies on VDOM diffing.

---

## 4. Deep Dive: Fict's Unique Features

### 4.1 Automatic Derivation vs. Explicit Primitives

Fict is unique in that there is **no** `$derived` or `computed` primitive in the user API.

- **Pros**: Smaller API surface area. "It just works."
- **Cons**: Implicit magic. If the compiler fails to detect dependencies (e.g., inside a black-box function), reactivity breaks. Fict mitigates this with `untrack` and warnings.

### 4.2 Control-Flow Branch Reactivity

Fict uses a compiler-first execution model:

- **Control flow return branches are reactive**: Supported return-branch control flow is lowered to conditional bindings.
- **JSX-only usage triggers fine-grained updates**: If signals are only read in JSX expressions, only the specific DOM nodes update.
- **Defining is not reading**: `const doubled = count * 2` creates a memo; branch bindings are only emitted when control-flow return usage requires it.

**Example 1: Reactive branch binding**

```tsx
let count = $state(0)
const doubled = count * 2 // just defines a memo
if (doubled) {
  /* `doubled` is READ at runtime here */
}
return <>{count}</> // When count changes, branch output updates reactively
```

**Example 2: Fine-grained update only**

```tsx
let count = $state(0)
const doubled = count * 2 // defined but never read in control flow
return <>{count}</> // When count changes, only text node updates
```

This matches developer intuition while maintaining performance.

### 4.3 "Region" Optimization

Fict groups related control flow logic into a single reactive "Region".

- **Problem**: In fine-grained reactivity (Solid), `if (a && b && c)` might create 3 separate subscriptions.
- **Fict Solution**: Compiles the entire block into a single Memo.
- **Benefit**: Reduces graph overhead and memory usage for complex component logic.

### 4.4 "Fiction" Philosophy

Fict encourages a mental model shift: **UI is a fiction layer**.

- Fict encourages writing `if (shouldShowSkeleton)` instead of `if (loading)`.
- This is not just a technical difference, but a **design pattern** encouraged by the documentation.

---

## 5. Conclusion: When to use Fict?

| Choose **Fict** if...                                                  | Choose **React 19** if...                             | Choose **Solid/Svelte** if...                                                |
| :--------------------------------------------------------------------- | :---------------------------------------------------- | :--------------------------------------------------------------------------- |
| You want the **cleanest syntax** (no `.value`, no setters).            | You need a **massive ecosystem** and library support. | You want **explicit** control over fine-grained performance.                 |
| You prefer **TSX** over templates (Svelte/Vue) but hate VDOM overhead. | You rely heavily on **Next.js / RSC**.                | You like the "run once" model but want a stable, production-ready framework. |
| You value **"UI as Fiction"**—explicitly modeling UX state.            | You are migrating a large existing codebase.          |                                                                              |
| You want native JS control flow with reactive branch lowering.         |                                                       |                                                                              |
| You want **automatic dependency tracking** without manual memoization. |                                                       |                                                                              |

**Final Verdict**:
Fict is a **hybrid model** combining the best of multiple frameworks:

- **Svelte 5's syntax**: Mutable `$state`, no setters
- **Solid's performance**: Fine-grained DOM updates when signals are only used in JSX
- **React-like ergonomics**: native TSX + natural control flow
- **React-like TSX experience**: No template DSL, just JavaScript

By making reactivity almost entirely implicit and compiling control flow into reactive bindings, Fict pushes compiler-driven UI development further while keeping developer intuition.
