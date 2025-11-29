# Fict

> Reactive UI with zero boilerplate.

Fict is a tiny (6kb) UI library where you write plain JavaScript and the compiler figures out the reactivity.

- `$state` for reactive data
- `$effect` for side effects
- Everything else is automatic

No `useMemo`. No dependency arrays. No `.value`. Just JavaScript.

```jsx
function Counter() {
  let count = $state(0)
  const doubled = count * 2  // auto-derived

  return <button onClick={() => count++}>{doubled}
}
```

**Why "Fict"?** Because UI is fiction — a narrative layer over your
real data. Fict makes that fiction explicit, testable, and trivial to write.

---

## Status

> ⚠️ **Experimental / pre-alpha**  
> Fict is a design-driven experiment in what a “fiction-first” UI model and a compiler-powered DX could look like.  
> **Do not** ship critical production code with it yet.

---

## Quick look

```tsx
import { $state, $effect } from "fict";

export function Counter() {
  let count = $state(0);

  const doubled = count * 2; // derived automatically

  $effect(() => {
    // explicit side effect
    document.title = `Count: ${count}`;
  });

  return <button onClick={() => count++}>{doubled}</button>;
}
```

What's happening here:

- `count` is a real `number`, not `Ref<number>` or `() => number`.
- You **read and write** it with normal JS (`count++`, `count = count + 1`).
- `doubled` is just a plain expression; Fict tracks it as a derived value.
- `$effect` marks “this code touches the outside world”.

Only two things are special:

1. **What can change** → `$state`
2. **What causes effects** → `$effect`

Everything else is ordinary TypeScript + JSX.

## Quick Start
```bash
# Not published yet — clone and build locally
git clone https://github.com/fictjs/fict.git
cd fict
pnpm install && pnpm build

# Try the playground
pnpm dev
```

### Example: The "Add to Cart" fiction

**Reality:**
```ts
// What actually happens
const addToCart = async (item) => {
  const result = await api.cart.add(item)  // Takes 500ms
  return result
}
```

**Fiction (what the user experiences):**
```tsx
function AddToCartButton({ item }) {
  let status = $state<'idle' | 'adding' | 'added'>('idle')
  
  const handleClick = async () => {
    status = 'adding'      // Instant feedback (fiction)
    await addToCart(item)  // Reality catches up
    status = 'added'       // Fiction updated
  }
  
  return (
    <button onClick={handleClick} disabled={status === 'adding'}>
      {status === 'idle' && 'Add to Cart'}
      {status === 'adding' && 'Adding...'}
      {status === 'added' && '✓ Added'}
    </button>
  )
}
```

The user sees a story: "I clicked → it's working → done!"  
The reality is slower. Fict helps you write that story clearly.

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
    { id: 2, text: 'Build something' }
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

### What does Fict compile to?
```tsx
// Your code
let count = $state(0)
const doubled = count * 2

return <div>{doubled}</div>
```
```tsx
// Conceptually compiles to (simplified)
const [$count, setCount] = createSignal(0)
const $doubled = createMemo(() => $count() * 2)

return (() => {
  const div = document.createElement('div')
  createEffect(() => div.textContent = $doubled())
  return div
})()
```

You don't write this. Fict does.

---

## Why Fict?

### 1. UI as a fiction layer, not just “views”

Most frameworks treat UI as “whatever your components render right now”. Fict is explicit about the gap between **reality** and **what the user sees**:

- **Reality** = your domain state: data, business rules, permissions.
- **Fiction** = a carefully constructed illusion on top of that state:

  - loading spinners
  - optimistic updates
  - skeletons and placeholders
  - escalations, warnings, nudges
  - progressive disclosure of complexity

Fict makes that fiction layer:

- **First-class**: you write it as straight TypeScript, not scattered across hooks and templates.
- **Testable**: you can assert on the narrative: “given this state, the user sees this story”.
- **Versionable**: product / design can evolve the fiction without rewriting the data layer.

> Fict’s design goal:
> **You should be able to read a component and understand the story it’s telling, before caring what the backend looks like.**

---

### 2. Minimal API: `$state` and `$effect` – that’s it

All modern UI frameworks have accumulated a zoo of primitives:

- React: `useState`, `useReducer`, `useMemo`, `useCallback`, `useEffect`, `useLayoutEffect`, `useSyncExternalStore`, …
- Solid: `createSignal`, `createStore`, `createMemo`, `createEffect`, `onCleanup`, `<Show>`, `<For>`, …
- Vue: `ref`, `reactive`, `computed`, `watchEffect`, `toRefs`, `defineProps`, `defineEmits`, …
- Svelte 5: `$state`, `$derived`, `$effect`, `$props`, `{#if}`, `{#each}`, …

Fict is intentionally boring:

```ts
import { $state, $effect } from "fict";
// (plus a tiny optional set of extras in `fict/plus` for advanced cases)
```

- `$state(initial)` → a value that can change.
- `$effect(fn)` → a block of code that produces side effects and cleans up.

That's it. Seriously.

Everything else – derived values, props, control flow, lists – is just **plain JS** on top of `$state`.

---

### 3. Derived values are “just expressions”

No more:

- `createMemo(() => …)`
- `computed(() => …).value`
- `$derived.by(() => …)`
- dependency arrays

In Fict:

```ts
let price = $state(100);
let quantity = $state(2);

// simple derivations
const subtotal = price * quantity;
const tax = subtotal * 0.1;
const total = subtotal + tax;

// conditional derivations
let discount = 0;
if (total > 100) {
  discount = total * 0.1;
}
```

The compiler:

- builds a dependency graph from `$state` to the expressions that use it
- groups related logic through your **real control flow** (no template DSL)
- only recomputes what is needed, when it is needed

You write the obvious code; Fict figures out the reactive wiring.

---

### 4. Native TSX: no templates, no SFCs, no magic files

Fict speaks **standard TypeScript + JSX**:

- multiple components per file
- normal ES modules (`export`, `export default`, named exports)
- native destructuring, defaults, rest/spread
- all the refactors your IDE already knows how to do

Props behave the way you expect:

```tsx
interface GreetingProps {
  name: string;
  age?: number;
  onClick: (id: string) => void;
}

export function Greeting({ name, age = 18, onClick }: GreetingProps) {
  let count = $state(0);
  const label = `${name} (${age}) – clicks: ${count}`;

  return (
    <button
      onClick={() => {
        count++;
        onClick(name);
      }}
    >
      {label}
    </button>
  );
}
```

No `defineProps`, no `toRefs`, no “don’t destructure or you lose reactivity” surprises.
Fict’s compiler keeps props reactive under the hood.

---

### 5. Components run once, but your intuition still holds

Fict’s component functions run **once** (like Solid / Svelte / Vue’s `setup()`), not on every render like React. This enables fine-grained updates without a virtual DOM.

However, that often creates a nasty gotcha in other frameworks:

- you define a **derived value** at module / component scope
- you read it later inside an **event handler**
- you accidentally capture a stale snapshot

Fict bakes in a hard rule to match your intuition:

> If a derived expression is **only used in events / plain functions**, it is compiled into an **on-demand getter**, so it always sees the latest state.

```tsx
let count = $state(0);
const doubled = count * 2; // used only in click handler below

const click = () => {
  // always logs the current value
  console.log("now", doubled);
};
```

The compiler turns this into something conceptually like:

```ts
const $doubled = () => $count() * 2;
const click = () => console.log("now", $doubled());
```

You don’t write getters. You just get the “always current” behavior you expect.

---

### 6. TypeScript that looks like TypeScript

In Fict, your types are the types you’d expect:

```ts
let count = $state(0); // count: number
const label = `Count: ${count}`; // label: string

let user = $state<{ name: string; age: number } | null>(null);
// user: { name: string; age: number } | null
```

No `Ref<T>`, no `Signal<T>`, no `Accessor<T>` leaking into your IDE:

- easier to read
- easier to refactor
- plays nicely with existing TS tooling and codebases

---

### 7. Less boilerplate for common tasks

A typical “fetch & show” component in Fict:

```tsx
import { $state, $effect } from "fict";

interface Props {
  userId: string;
}

export function UserProfile({ userId }: Props) {
  let user = $state<{ firstName: string; lastName: string } | null>(null);
  let loading = $state(true);

  const fullName = user ? `${user.firstName} ${user.lastName}` : "";

  $effect(() => {
    loading = true;
    fetch(`/api/user/${userId}`)
      .then((res) => res.json())
      .then((data) => {
        user = data;
        loading = false;
      });
  });

  if (loading) return <Spinner />;
  return <div>{fullName}</div>;
}
```

Compared to equivalent React / Solid / Vue / Svelte implementations, you avoid:

- setter functions / extra stores
- wrapper APIs for derived values
- `.value` or `()` to unwrap types
- separate template syntax

---

## Core concepts

### `$state(initial)`

Declare something that can change:

```ts
let count = $state(0);
count++; // update
count = count + 1; // still fine
```

- Reads are plain (`count`).
- Writes are plain (`count = …`).
- Arrays / objects use normal JS APIs (`push`, `map`, spreads, etc.).
- Derived values depending on `$state` are tracked automatically.

### Automatic derivations

Any expression that depends (directly or indirectly) on `$state` is a **derived value**:

```ts
const subtotal = price * quantity;
const tax = subtotal * 0.1;
const total = subtotal + tax;
```

Fict’s compiler:

- builds a dependency graph
- groups related logic through your `if`, `switch`, `for`, etc.
- only recomputes what is needed, when something it depends on changes

You never write `createMemo` / `$derived` / `computed`.

### `$effect(fn)`

Mark “this code touches the outside world”:

```ts
$effect(() => {
  console.log("count changed to", count);
});

$effect(() => {
  const id = setInterval(() => {
    console.log("tick", count);
  }, 1000);
  return () => clearInterval(id); // cleanup when dependencies change
});
```

Rules:

- Fict tracks which `$state` values are read inside the effect.
- When those change:

  - cleanup runs first (if you returned one)
  - then the effect runs again

- Async effects can return a cleanup that cancels in-flight work.

### Components as single-execution functions

A Fict component:

- is a plain function
- runs once
- returns JSX
- registers its bindings (`$state`, derived expressions, `$effect`, event handlers) with the runtime

Fine-grained updates are driven by the dependency graph, not by calling the component again.

---

## How Fict compares (high-level)

Very roughly:

- **vs React + Compiler**

  - similar “auto-derived” ambition
  - but with **mutable assignments** (`count++`) and no setters
  - components run once, no VDOM required

- **vs Solid**

  - similar fine-grained graph
  - but without `signal()` / `()` getter ceremony
  - props can be freely destructured
  - deriveds and effects are inferred, not manually wired

- **vs Svelte 5 (Runes)**

  - similar `$state` & `$effect` feel
  - but no `$derived` primitive
  - no Svelte-specific file format or template syntax – just TSX

- **vs Vue 3**

  - no `ref` vs `reactive` split
  - no `.value`
  - no template DSL – JSX only

If you like the **reading experience** of Svelte 5 / Vue SFCs, but want:

- TSX
- fewer concepts
- and a stronger “UI as fiction over state” philosophy

…Fict is aimed squarely at that spot.

---

## What Fict is not (yet)

Fict is **not** trying to be a full framework right now:

- no official router
- no SSR / streaming implementation yet
- no official form library
- no design system / component kit
- no ecosystem of plugins

The current focus is:

1. Compiler & runtime core (`$state`, automatic derivations, `$effect`)
2. Correct semantics in tricky cases (events, async effects, control flow)
3. Tooling: diagnostics & DevTools that can explain “why did this update?”

---

## Roadmap

Planned areas (subject to change):

- **Core**

  - [ ] Stable `$state` / `$effect` semantics
  - [ ] Cross-module derived value support
  - [ ] Better dev warnings for unsafe patterns

- **Advanced APIs (opt-in, likely in `fict/plus`)**

  - [ ] `$store` for deep/path-level tracking (complex forms, editors)
  - [ ] `resource` for declarative async data (cache, de-dupe, cancellation)
  - [ ] `transition` / `task` for scheduling and low-priority updates
  - [ ] `noTrack` escape hatch for black-box libraries

- **Tooling**

  - [ ] Vite plugin
  - [ ] ESLint rules for common footguns
  - [ ] DevTools panel (inspect graph, “why did this rerender?”)

- **Docs**

  - [ ] Deeper “Fiction UI” guide – how to design the narrative layer
  - [ ] Migration notes from React / Vue / Svelte / Solid
  - [ ] Patterns for forms, lists, async flows

---

## FAQ

### Is Fict production-ready?

No. It’s an experimental project exploring a different way to think about UI: as fiction over real state, with a compiler doing most of the reactive wiring.

### Does Fict use a virtual DOM?

No. Components run once. Fict compiles JSX into fine-grained bindings that update the DOM directly.

### Can I mix Fict with React / Vue / …?

In theory, yes – they all compile to JS – but there is no official integration story yet. For now, treat Fict as something you experiment with in isolated apps, sandboxes, and prototypes.

### How does Fict handle arrays/objects?

Default: whole-value tracking (immutable style recommended)
```ts
let todos = $state([])
todos = [...todos, newTodo]  // ✅ Triggers update
```

For deep mutations, use `$store` from `fict/plus` (coming soon).

### What about Server Components / SSR?

Not yet. Focus is on client-side reactivity first.  
SSR is on the roadmap.

### Can I use Fict with existing React components?

Not directly. Fict compiles to direct DOM operations, not React elements.  
Interop would require a wrapper (not built yet).

### How big is the runtime?

Target: ~6kb gzipped (core only).

### TypeScript setup

Fict works with standard `tsconfig.json`:
```json
{
  "compilerOptions": {
    "jsx": "preserve",
    "jsxImportSource": "fict"
  }
}
```

Types flow naturally — `$state(0)` gives you `number`, not `Signal<number>`.

## Contributing

TBD

## License

Fict is [MIT licensed](https://github.com/fictjs/fict/blob/main/LICENSE).