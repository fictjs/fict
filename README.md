# Fict

![Node CI](https://github.com/fictjs/fict/workflows/Node%20CI/badge.svg)
![npm](https://img.shields.io/npm/v/fict.svg)
![license](https://img.shields.io/npm/l/fict)

> Reactive UI with zero boilerplate.

Fict is a UI library where you write plain JavaScript and the compiler figures out the reactivity.

```jsx
function Counter() {
  let count = $state(0)
  const doubled = count * 2 // auto-derived, no useMemo needed

  return <button onClick={() => count++}>{doubled}</button>
}
```

**No `useMemo`. No dependency arrays. No `.value`. Just JavaScript.**

---

## Why Fict?

| Pain Point        | React                  | Solid                         | Svelte 5        | Fict          |
| ----------------- | ---------------------- | ----------------------------- | --------------- | ------------- |
| State syntax      | `useState()` + setter  | `createSignal()` + `()` calls | `$state()`      | `$state()`    |
| Derived values    | `useMemo` + deps array | `createMemo()`                | `$derived()`    | **automatic** |
| Props destructure | ✅                     | ❌ breaks reactivity          | via `$props()`  | ✅            |
| Control flow      | native JS              | `<Show>/<For>`                | `{#if}/{#each}` | native JS     |

Fict gives you:

- **React's familiar syntax** — JSX, destructuring, native `if`/`for`
- **Solid's fine-grained performance** — no VDOM, surgical DOM updates
- **Less boilerplate than both** — compiler infers derived values automatically

---

## Quick Start

```bash
npm install fict
# yarn add mutative
# pnpm add mutative
```

**Vite setup:**

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import fict from '@fictjs/vite-plugin'

export default defineConfig({
  plugins: [fict()],
})
```

**TypeScript:**

```json
{
  "compilerOptions": {
    "jsx": "preserve",
    "jsxImportSource": "fict"
  }
}
```

---

## Core Concepts

### `$state` — Reactive data

```ts
let count = $state(0)
count++ // ✅ direct mutation
count = count + 1 // ✅ assignment
```

### Automatic derivations — No `useMemo` needed

```ts
let price = $state(100)
let quantity = $state(2)

const subtotal = price * quantity // auto-derived
const tax = subtotal * 0.1 // auto-derived
const total = subtotal + tax // auto-derived
```

The compiler builds a dependency graph and only recomputes what's needed.

### `$effect` — Side effects

```ts
$effect(() => {
  console.log('count is now', count)
  return () => {
    /* cleanup */
  }
})
```

---

## Execution Model: Not React, Not Solid

**This is the most important concept to understand.**

```tsx
function Counter() {
  console.log('A') // 🔵 Runs ONCE
  let count = $state(0)
  const doubled = count * 2
  console.log('B', doubled) // 🟢 Runs on EVERY count change
  return (
    <button onClick={() => count++}>
      {(console.log('C'), doubled)} {/* 🟢 Runs on every change */}
      {(console.log('D'), 'static')} {/* 🔵 Runs ONCE */}
    </button>
  )
}
```

**Initial render:** `A → B 0 → C → D`

**After click (count: 0 → 1):** `B 2 → C` (A and D don't run!)

### The mental model

| Framework | What happens on state change                                     |
| --------- | ---------------------------------------------------------------- |
| React     | Entire component function re-runs                                |
| Solid     | Component runs once; you manually wrap derived values            |
| **Fict**  | Component runs once; **code depending on state** auto-recomputes |

Fict splits your component into "reactive regions":

- Code before `$state`: runs once
- Expressions using state (`count * 2`): recompute when dependencies change
- Static JSX: runs once

---

## Examples

### Conditional rendering

```tsx
function App() {
  let show = $state(true)

  return (
    <div>
      {show && <Modal />}
      {show ? <A /> : <B />}
    </div>
  )
}
```

No `<Show>` or `{#if}` — just JavaScript.

### List rendering

```tsx
function TodoList() {
  let todos = $state([
    { id: 1, text: 'Learn Fict' },
    { id: 2, text: 'Build something' },
  ])

  return (
    <ul>
      {todos.map(todo => (
        <li key={todo.id}>{todo.text}</li>
      ))}
    </ul>
  )
}
```

No `<For>` or `v-for` — just `.map()`.

### Async data fetching

```tsx
function UserProfile({ userId }: { userId: string }) {
  let user = $state<User | null>(null)
  let loading = $state(true)

  $effect(() => {
    const controller = new AbortController()
    loading = true

    fetch(`/api/user/${userId}`, { signal: controller.signal })
      .then(res => res.json())
      .then(data => {
        user = data
        loading = false
      })

    return () => controller.abort() // cleanup on userId change
  })

  if (loading) return <Spinner />
  return <div>{user?.name}</div>
}
```

### Props stay reactive

```tsx
function Greeting({ name, age = 18 }: { name: string; age?: number }) {
  const label = `${name} (${age})` // auto-derived from props
  return <span>{label}</span>
}
```

Destructuring works. No `toRefs()` or special handling needed.

---

## What Fict Compiles To

```tsx
// Your code
function Counter() {
  let count = $state(0)
  const doubled = count * 2
  return <div>{doubled}</div>
}

// Compiled output (simplified)
function Counter() {
  const [count, setCount] = createSignal(0)
  const doubled = createMemo(() => count() * 2)

  const div = document.createElement('div')
  createEffect(() => {
    div.textContent = doubled()
  })
  return div
}
```

You write the simple version. The compiler generates the efficient version.

---

## Advanced Features

### Error Boundaries

```tsx
import { ErrorBoundary } from 'fict'
;<ErrorBoundary fallback={err => <p>Error: {String(err)}</p>}>
  <RiskyComponent />
</ErrorBoundary>
```

### Suspense

```tsx
import { Suspense } from 'fict'
import { resource, lazy } from 'fict/plus'

const userResource = resource({
  suspense: true,
  fetch: (_, id: number) => fetch(`/api/user/${id}`).then(r => r.json()),
})

const LazyChart = lazy(() => import('./Chart'))

function Profile({ id }) {
  return (
    <Suspense fallback="Loading...">
      <h1>{userResource.read(() => id).data?.name}</h1>
      <LazyChart />
    </Suspense>
  )
}
```

### `fict/plus` — Advanced APIs

```tsx
import { $store, resource, lazy, untrack } from 'fict/plus'

// Deep reactivity with path-level tracking
let user = $store({ name: 'Alice', address: { city: 'London' } })
user.address.city = 'Paris' // fine-grained update

// Escape hatch for black-box functions
const result = untrack(() => externalLib.compute(count))
```

---

## Control Flow and Re-execution

When does a component re-execute vs just update DOM?

**JSX-only reads → Fine-grained DOM updates:**

```tsx
let count = $state(0)
return <div>{count}</div> // Only the text node updates
```

**Control flow reads → Component re-executes:**

```tsx
let count = $state(0)
if (count > 10) return <Special /> // Component re-runs when count changes
return <Normal />
```

The compiler detects this automatically. You don't need to think about it — write natural `if`/`for` and Fict does the right thing.

---

## Framework Comparison

| Feature           | React+Compiler | Solid            | Svelte 5        | Vue 3             | Fict          |
| ----------------- | -------------- | ---------------- | --------------- | ----------------- | ------------- |
| State syntax      | `useState()`   | `createSignal()` | `$state()`      | `ref()`           | `$state()`    |
| Read state        | `count`        | `count()`        | `count`         | `count.value`     | `count`       |
| Update state      | `setCount(n)`  | `setCount(n)`    | `count = n`     | `count.value = n` | `count = n`   |
| Derived values    | auto           | `createMemo()`   | `$derived()`    | `computed()`      | **auto**      |
| Props destructure | ✅             | ❌               | via `$props()`  | via `toRefs()`    | ✅            |
| Control flow      | native JS      | `<Show>/<For>`   | `{#if}/{#each}` | `v-if/v-for`      | native JS     |
| File format       | `.jsx`/`.tsx`  | `.jsx`/`.tsx`    | `.svelte`       | `.vue`            | `.jsx`/`.tsx` |
| Rendering         | VDOM           | fine-grained     | fine-grained    | fine-grained      | fine-grained  |

---

## Status

> ⚠️ **Beta** — Fict v1.0 is feature-complete for core compiler and runtime. API is stable, but edge cases may be refined. Production use is possible for adventurous teams.

## Roadmap

### Completed (v1.0)

- [x] Compiler with HIR/SSA
- [x] Stable `$state` / `$effect` semantics
- [x] Automatic derived value inference
- [x] `$store`, `resource`, `lazy`, `transition` in `fict/plus`
- [x] Vite plugin
- [x] ESLint plugin
- [ ] Support sourcemap
- [ ] DevTools
- [ ] SSR / streaming

### Planned

- [ ] TypeScript language service plugin
- [ ] Migration guides from React/Vue/Svelte/Solid
- [ ] Router
- [ ] Testing library

---

## Documentation

- [Architecture](./docs/architecture.md) — How the compiler and runtime work
- [Compiler Spec](./docs/compiler-spec.md) — Formal semantics
- [ESLint Rules](./docs/eslint-rules.md) — Linting configuration
- [Diagnostic Codes](./docs/diagnostic-codes.md) — Compiler warnings reference

### Linting & diagnostics

- Install `@fictjs/eslint-plugin` and extend `plugin:fict/recommended` to mirror compiler guardrails.
- Key rules: nested component definitions (FICT-C003), missing list keys (FICT-J002), memo side effects (FICT-M003), empty `$effect` (FICT-E001), component return checks (FICT-C004), plus `$state` placement/alias footguns.
- Example `.eslintrc`:

```json
{
  "plugins": ["fict"],
  "extends": ["plugin:fict/recommended"]
}
```

- Recommended config mirrors compiler warnings so IDE diagnostics stay aligned with build output.

---

## FAQ

**Is Fict production-ready?**
Beta. Core is stable, but expect edge cases. Test thoroughly for critical apps.

**Does Fict use a virtual DOM?**
No. Components run once. JSX compiles to direct DOM operations.

**How does Fict handle arrays?**
Default: immutable style (`todos = [...todos, newTodo]`). For deep mutations, use `$store` from `fict/plus`.

**Can I use existing React components?**
Not directly. Fict compiles to DOM operations, not React elements.

**How big is the runtime?**
~13kb gzipped (core only).

---

## License

[MIT](https://github.com/fictjs/fict/blob/main/LICENSE)
