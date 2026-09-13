<p align="center">
  <a href="https://github.com/fictjs/fict">
    <img src="./logo.png" alt="Fict Logo" width="160" />
  </a>
</p>

<h1 align="center">Fict</h1>

<p align="center">
  <strong>Reactive UI with zero boilerplate.</strong><br/>
  Write JavaScript; let the compiler handle signals, derived values, and DOM updates.
</p>

<p align="center">
  <a href="https://github.com/fictjs/fict/actions"><img src="https://github.com/fictjs/fict/workflows/CI/badge.svg" alt="CI" /></a>
  <a href="https://www.npmjs.com/package/fict"><img src="https://img.shields.io/npm/v/fict.svg?colorB=brightgreen" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/fict"><img src="https://img.shields.io/npm/dm/fict.svg" alt="npm downloads" /></a>
  <a href="https://github.com/fictjs/fict/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/fict" alt="license" /></a>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#core-concepts">Core Concepts</a> ·
  <a href="#examples">Examples</a> ·
  <a href="#documentation">Docs</a> ·
  <a href="https://stackblitz.com/edit/vite-fict-ts?file=src%2Fmain.tsx">Playground</a>
</p>

---

```jsx
function Counter() {
  let count = $state(0)
  const doubled = count * 2 // auto-derived

  return <button onClick={() => count++}>{doubled}</button>
}
```

**No `useMemo`. No dependency arrays. No `.value`. Just JavaScript.**

---

## Why Fict?

> _"Write JavaScript; the compiler handles reactivity."_
> No `.value`, no deps arrays, no manual memo wiring. Not pitching "better React/Vue/Svelte" — Fict is a **different mental model**: compile-time reactivity on plain JS. The gain: **less code, lower cognitive overhead**.

<table>
  <thead>
    <tr>
      <th>Pain Point</th>
      <th>React</th>
      <th>Vue 3</th>
      <th>Solid</th>
      <th>Svelte 5</th>
      <th>Fict ✨</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td><strong>State syntax</strong></td>
      <td><code>useState()</code> + setter</td>
      <td><code>ref()</code> + <code>.value</code></td>
      <td><code>createSignal()</code> + <code>()</code></td>
      <td><code>$state()</code></td>
      <td><code>$state()</code></td>
    </tr>
    <tr>
      <td><strong>Derived values</strong></td>
      <td><code>useMemo</code> + deps</td>
      <td><code>computed()</code></td>
      <td><code>createMemo()</code></td>
      <td><code>$derived()</code></td>
      <td><strong>automatic</strong> 🔥</td>
    </tr>
    <tr>
      <td><strong>Props destructure</strong></td>
      <td>✅</td>
      <td>⚠️ breaks reactivity</td>
      <td>❌ breaks reactivity</td>
      <td>✅ (<code>$props()</code>)</td>
      <td>✅</td>
    </tr>
    <tr>
      <td><strong>Control flow</strong></td>
      <td>native JS</td>
      <td><code>v-if</code>/<code>v-for</code></td>
      <td><code>&lt;Show&gt;</code>/<code>&lt;For&gt;</code></td>
      <td><code>{#if}</code>/<code>{#each}</code></td>
      <td>native JS</td>
    </tr>
  </tbody>
</table>

**Fict's bet:**

- React-style TSX ergonomics with destructuring-friendly props and native
  control flow.
- Solid-style fine-grained DOM updates without getter calls in component code.
- Compile-time guarantees that fail closed when the compiler cannot prove
  reactive behavior.

The goal is not to be the smallest possible runtime. Fict trades compiler
complexity for React-like authoring, automatic derivation, package metadata,
and strict reactivity guarantees.

---

## Quick Start

```bash
npm install fict
npm install -D @fictjs/vite-plugin  # Vite users
```

<details>
<summary><strong>📦 Counter App — full example</strong></summary>

```tsx
import { $state, render } from 'fict'

export function Counter() {
  let count = $state(0)
  const doubled = count * 2 // auto-derived

  return (
    <div class="counter">
      <h1>Fict Counter</h1>
      <div class="card">
        <button onClick={() => count--}>-</button>
        <span class="count">{count}</span>
        <button onClick={() => count++}>+</button>
      </div>
      <p class="doubled">Doubled: {doubled}</p>
    </div>
  )
}

render(() => <Counter />, document.getElementById('app')!)
```

</details>

<details>
<summary><strong>⚙️ Vite config</strong></summary>

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import fict from '@fictjs/vite-plugin'

export default defineConfig({
  plugins: [fict()],
})
```

</details>

<details>
<summary><strong>🔧 TypeScript config</strong></summary>

```json
{
  "compilerOptions": {
    "jsx": "preserve",
    "jsxImportSource": "fict"
  }
}
```

</details>

---

## Online Examples

- 🎮 [Counter](https://stackblitz.com/edit/vite-fict-ts?file=src%2Fmain.tsx)

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
Single-use derived values may be inlined as an optimization; use `$memo` to
force an explicit memo node.

### `$effect` — Side effects

```ts
$effect(() => {
  console.log(`count is now ${count}`)
  return () => {
    /* cleanup */
  }
})
```

---

## Execution Model: Not React, Not Solid

> **This is the most important concept to understand.**

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

| Phase                        | Output            | Why                  |
| :--------------------------- | :---------------- | :------------------- |
| **Initial render**           | `A → B 0 → C → D` | Everything runs once |
| **After click** (count: 0→1) | `B 2 → C`         | A and D don't run!   |

### The mental model

| Framework | What happens on state change                                     |
| :-------- | :--------------------------------------------------------------- |
| React     | Entire component function re-runs                                |
| Solid     | Component runs once; you manually wrap derived values            |
| **Fict**  | Component runs once; **code depending on state** auto-recomputes |

Fict splits your component into **reactive regions**:

- 🔵 Code before `$state`: runs **once**
- 🟢 Expressions using state (`count * 2`): **recompute** when dependencies change
- 🔵 Static JSX: runs **once**

---

## Examples

Runnable examples live under `examples/`, including Vite, Webpack, SSR, streaming, resumability,
forms, dashboards, nested routing, and auth/error/loading flows. The docs index at
`packages/docs-site/docs/examples/index.md` lists the current set.

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
// ✍️ Your code
function Counter() {
  let count = $state(0)
  const doubled = count * 2
  return <div>{doubled}</div>
}

// ⚡ Compiled output (simplified)
function Counter() {
  const count = createSignal(0)
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

### SSR Streaming

Fict SSR supports shell-first streaming with Suspense boundary patching:

```tsx
import { renderToPipeableStream } from '@fictjs/ssr'

const { pipe, shellReady, allReady } = renderToPipeableStream(() => <App />, {
  mode: 'shell',
})

pipe(res)
await shellReady
await allReady
```

<details>
<summary><strong>🧪 Partial prerendering (Preview)</strong></summary>

```tsx
import { renderToPartial } from '@fictjs/ssr/experimental'

const { shell, stream } = renderToPartial(() => <App />, { mode: 'shell' })
// shell: complete fallback HTML
// stream: deferred boundary patches
```

`renderToPartial` is an advanced API (Preview in v1.0).
Resumable handlers and partial prerendering are active preview work, not a
stable Qwik-compatible contract.

</details>

### `fict/plus` — Advanced APIs

```tsx
import { $store, untrack } from 'fict'
import { resource, lazy } from 'fict/plus'

// Deep reactivity with path-level tracking
const user = $store({ name: 'Alice', address: { city: 'London' } })
user.address.city = 'Paris' // fine-grained update

// Derived values are auto-memoized, just like $state
const greeting = `Hello, ${user.name}` // auto-derived

// Method chains are also auto-memoized
const store = $store({ items: [1, 2, 3, 4, 5] })
const doubled = store.items.filter(n => n > 2).map(n => n * 2) // auto-memoized

// Dynamic property access works with runtime tracking
const value = store[props.key] // reactive, updates when key or store changes

// Escape hatch for black-box functions
const result = untrack(() => externalLib.compute(count))
```

<details>
<summary><strong>📊 <code>$store</code> vs <code>$state</code></strong></summary>

| Feature        | `$state`                   | `$store`                 |
| :------------- | :------------------------- | :----------------------- |
| Depth          | Shallow                    | Deep (nested objects)    |
| Access         | Direct value               | Proxy-based              |
| Mutations      | Reassignment               | Direct property mutation |
| Derived values | Auto-memoized              | Auto-memoized            |
| Best for       | Primitives, simple objects | Complex nested state     |

`$store` is the only user-facing deep store API. Internal `createStore` helpers
exist for compiler/runtime infrastructure and should not be imported by app code.

</details>

---

## Control Flow and Branch Reactivity

Fict components execute once on mount. Reactive updates happen through bindings/memos.

**JSX-only reads → fine-grained DOM updates:**

```tsx
let count = $state(0)
return <div>{count}</div> // Only the text node updates
```

**Control flow returns → compiler emits reactive branch bindings:**

```tsx
let count = $state(0)
if (count > 10) return <Special /> // branch swaps reactively when count changes
return <Normal />
```

The compiler detects supported patterns (`if-return`, `switch-return`, `try` blocks containing
return branches) and lowers them to reactive conditionals.

---

## Framework Comparison

| Feature           | React+Compiler | Solid            | Svelte 5        | Vue 3             | Fict ✨       |
| :---------------- | :------------- | :--------------- | :-------------- | :---------------- | :------------ |
| State syntax      | `useState()`   | `createSignal()` | `$state()`      | `ref()`           | `$state()`    |
| Read state        | `count`        | `count()`        | `count`         | `count.value`     | `count`       |
| Update state      | `setCount(n)`  | `setCount(n)`    | `count = n`     | `count.value = n` | `count = n`   |
| Derived values    | auto           | `createMemo()`   | `$derived()`    | `computed()`      | **auto**      |
| Props destructure | ✅             | ❌               | via `$props()`  | via `toRefs()`    | ✅            |
| Control flow      | native JS      | `<Show>`/`<For>` | `{#if}/{#each}` | `v-if/v-for`      | native JS     |
| File format       | `.jsx`/`.tsx`  | `.jsx`/`.tsx`    | `.svelte`       | `.vue`            | `.jsx`/`.tsx` |
| Rendering         | VDOM           | fine-grained     | fine-grained    | fine-grained      | fine-grained  |

---

## Performance

### js-framework-benchmark — 2026-09-13

Historical comparison of the archived 0.34.0 fixture, compiler, and runtime.
The subsequent async graph changes and current strict fixture require a new
qualified batch; this table does not measure them. Mean total durations are milliseconds, including browser
rendering; lower is better. Chrome 152.0.7977.83 on macOS arm64, headless, with
identical per-case throttling. Each case has 15 samples; selection has 25.

| Benchmark                       | Vue Vapor |  Solid | Svelte 5 |   Fict | React Compiler |
| :------------------------------ | --------: | -----: | -------: | -----: | -------------: |
| Create rows (1k)                |     30.99 |  30.32 |    31.27 |  35.77 |          36.81 |
| Replace all rows (1k)           |     35.41 |  35.01 |    36.31 |  41.47 |          45.33 |
| Partial update (every 10th row) |     19.71 |  18.84 |    19.71 |  19.83 |          25.07 |
| Select row                      |      6.12 |   6.76 |     9.16 |   6.27 |          13.76 |
| Swap rows                       |     21.57 |  22.21 |    22.41 |  22.65 |         146.31 |
| Remove row                      |     17.10 |  16.91 |    17.04 |  17.55 |          19.61 |
| Create many rows (10k)          |    337.70 | 332.10 |   336.85 | 365.26 |         621.51 |
| Append rows (1k to 1k)          |     36.83 |  36.72 |    36.93 |  41.53 |          43.36 |
| Clear rows (1k)                 |     15.00 |  18.53 |    17.09 |  17.43 |          27.57 |
| **CPU geometric mean**          |     1.012 |  1.039 |    1.082 |  1.101 |          1.745 |

Each case is normalized to its fastest mean among these five implementations;
the geometric mean gives equal weight to the nine CPU cases. Fict's score is
**1.100919** to six decimals. Against the original comparison's fixed denominators it
is **1.104012**, a **16.99%** reduction from **1.329953**.
The strict **≤1.10** check did **not** pass under either normalization.

The default fixture now uses a selector, per-row label signals, `textContent`,
and stable row captures. Automatic compiler/runtime optimizations reduce
template traversal, binding, allocation, and disposal costs. The compiler does
not infer that source representation for arbitrary applications.

**Versions:** Vue Vapor 3.6.0-alpha.2 · Solid 1.9.3 · Svelte 5.42.1 · Fict 0.34.0
(workspace implementation based on `27dbe2d9`) · React 19.0.0 with React Compiler
`19.0.0-beta-37ed2a7-20241206`.

The Fict build passed the browser model and official keyed checks; the reference
bundles retain their previously checked source and hashes. These are local,
recorded versions and workloads. See [implemented changes, validation, and
remaining costs](./docs/runtime-benchmark.md#implemented-optimizations-2026-09-13)
and [raw samples and exact source/bundle provenance](./docs/benchmarks/runtime-implementation-2026-09-13.json).
See the [benchmark history](./docs/runtime-benchmark.md#framework-comparison-2026-09-12)
for the earlier five-framework comparison and source experiments.

---

## Status & Roadmap

> ⚠️ **Alpha** — Fict is feature-complete for core compiler and runtime. API is stable, but edge cases may be refined. **Don't use it in production yet.**

### ✅ Completed

- [x] Compiler with HIR/SSA
- [x] Stable `$state` / `$effect` semantics
- [x] Automatic derived value inference
- [x] `$store` in `fict`, `resource`/`lazy` in `fict/plus`
- [x] `startTransition`, `useTransition`, `useDeferredValue` in `fict`
- [x] Vite plugin
- [x] ESLint plugin
- [x] Support sourcemap
- [x] DevTools
- [x] Router
- [x] Testing library
- [x] SSR / streaming

### 🗺️ Planned

- [x] Initial migration guide from React/Vue/Svelte/Solid
- [ ] Framework-specific migration recipes and maintained real-world templates

---

## Documentation

| Doc                                                               | Description                            |
| :---------------------------------------------------------------- | :------------------------------------- |
| [Architecture](./docs/architecture.md)                            | How the compiler and runtime work      |
| [API Reference](./docs/api-reference.md)                          | Complete API documentation             |
| [Compiler Spec](./docs/compiler-spec.md)                          | Formal semantics                       |
| [Migration Guide](./docs/migration-guide.md)                      | React/Vue/Svelte/Solid migration       |
| [Strict Guarantee Cookbook](./docs/strict-guarantee-cookbook.md)  | Fail-closed diagnostic rewrites        |
| [Store API](./docs/store-api.md)                                  | `$state` vs `$store` ownership         |
| [Release Policy](./docs/release-policy.md)                        | SemVer and changelog standards         |
| [Scope Contract](./SCOPE.md)                                      | Core/Satellite/Preview/Internal tiers  |
| [Preview Policy](./docs/PREVIEW.md)                               | Preview surface + degradation contract |
| [ESLint Rules](./docs/eslint-rules.md)                            | Linting configuration                  |
| [Diagnostic Codes](./docs/diagnostic-codes.md)                    | Compiler warnings reference            |
| [Config Profiles](./docs/config-profiles.md)                      | Recommended dev/CI/prod settings       |
| [Compiler Maintenance](./docs/compiler-maintenance.md)            | Compiler complexity guardrails         |
| [Cycle Protection](./docs/cycle-protection.md)                    | Dev-mode infinite loop detection       |
| [SSR SEO Guide](./docs/ssr-seo.md)                                | SEO best practices for SSR pages       |
| [SSR Performance](./docs/ssr-performance.md)                      | Snapshot size & render-mode tuning     |
| [SSR Deployment](./docs/ssr-deployment.md)                        | Vercel/Cloudflare/edge deployment      |
| [Security Boundaries](./docs/architecture/security-boundaries.md) | HTML/snapshot/CSP/isolation review     |
| [DevTools](./packages/devtools/README.md)                         | Vite plugin usage & auto-injection     |

<details>
<summary><strong>🔍 Linting & diagnostics</strong></summary>

Install `@fictjs/eslint-plugin` and extend `plugin:fict/recommended`:

```json
{
  "plugins": ["fict"],
  "extends": ["plugin:fict/recommended"]
}
```

Key rules: nested component definitions (FICT-C003), missing list keys (FICT-J002), memo side effects (FICT-M003), empty `$effect` (FICT-E001), component return checks (FICT-C004), plus `$state` placement/alias footguns.

- Recommended config mirrors compiler warnings so IDE diagnostics stay aligned with build output.
- For strict CI gates, enable compiler `strictReactivity: true` to escalate the `FICT-R006` control-flow fallback diagnostic to a build error.
- `strictGuarantee` is enabled by default for fail-closed guarantees.
- Production compilation (`NODE_ENV=production`) force-enables `strictGuarantee` even when an integration opts out.
- Set `strictGuarantee: false` only for non-production migration or benchmark builds.
- CI can force strict mode with `FICT_STRICT_GUARANTEE=1` during build steps.
- Guarantee boundary reference: `docs/reactivity-guarantee-matrix.md`.

</details>

---

## FAQ

<details>
<summary><strong>Is Fict production-ready?</strong></summary>

Alpha. Core is stable, but expect edge cases. Test thoroughly for critical apps.

</details>

<details>
<summary><strong>Does Fict use a virtual DOM?</strong></summary>

No. Fict compiles to direct DOM operations for surgical, fine-grained updates.

</details>

<details>
<summary><strong>How does Fict handle arrays?</strong></summary>

Default: immutable style (`todos = [...todos, newTodo]`). For deep mutations,
use spread to create new immutable data, or use Immer/Mutative, or use `$store`
from `fict`.

</details>

<details>
<summary><strong>Can I use existing React components?</strong></summary>

Not directly. Fict compiles to DOM operations, not React elements.

</details>

<details>
<summary><strong>How big is the runtime?</strong></summary>

Bundle size depends on the imported entrypoints and tree shaking. The runtime
includes scheduling, hydration/resume, stores, and diagnostics. For measured
table-workload timing and page memory, see the [performance snapshot](#performance).
Creation and memory costs remain higher than the local Solid reference.

</details>

---

## Known Limitations

The compiler has some limitations when handling conditional rendering patterns.

### Control-flow patterns supported

- Multiple sequential `if-return` branches are compiled into reactive conditionals.
- `if` blocks without `return` are auto-wrapped so reactive side effects still update.
- Nested branch logic (e.g. inner `if`/`switch`) and reactive prelude reads before
  `return` are automatically kept reactive. When fine-grained lowering is not possible,
  the compiler enables a safe runtime fallback that tracks branch reads and re-runs
  the active branch.

---

## Acknowledgments

Fict is built upon the brilliant ideas and relentless innovation of the open-source community. We express our deepest respect and gratitude to these projects:

- **[React](https://react.dev/)** — For defining the modern era of UI development. Its component model and declarative philosophy set the standard for developer experience.
- **[React Compiler](https://react.dev/learn/react-compiler)** — For proving that automatic memoization and compiler-owned reactivity can reduce manual dependency bookkeeping while preserving React semantics.
- **[Solid](https://www.solidjs.com/)** — For pioneering fine-grained reactivity and demonstrating the power of compilation. Its architecture is the bedrock upon which Fict's performance is built.
- **[Qwik](https://qwik.dev/)** — For its outstanding resumability-first SSR vision. Its approach to instant interactivity has been a major inspiration for Fict's resumable SSR direction.
- **[Million.js](https://million.dev/)** — For exploring compiler-assisted React performance and helping popularize the idea that UI performance can be shifted from runtime work into build-time analysis.
- **[alien-signals](https://github.com/stackblitz/alien-signals)** — For pushing the boundaries of signal performance. Its implementation provided critical guidance for Fict's reactive system.

---

<p align="center">
  <a href="https://github.com/fictjs/fict/blob/main/LICENSE">MIT License</a> · © Fict Contributors
</p>
