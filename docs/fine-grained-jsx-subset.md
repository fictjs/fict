# Fine-Grained JSX Subset & Helper Spec

**Status:** Draft ready for implementation  
**Last updated:** 2025-12-04T19:30:00Z

## 1. Supported JSX Surface (Phase 0 scope)

| Feature                                               | Status               | Notes                                                                      |
| ----------------------------------------------------- | -------------------- | -------------------------------------------------------------------------- |
| Intrinsic elements (`<div>`, `<span>`, etc.)          | ✅                   | Props lowered to attribute/property bindings.                              |
| Fragment syntax (`<>...</>`, `<Fragment>`)            | ✅                   | Flattens to deterministic child sequences.                                 |
| Expressions in text/props (`{expr}`)                  | ✅                   | Each expression lowered to a dedicated binding helper.                     |
| Conditional expressions (`cond ? A : B`, `cond && A`) | ✅                   | Compile to `createConditional` wrappers with stable truthy/falsy closures. |
| Array `.map` for keyed lists                          | ✅                   | Requires explicit `key` expression; codegen emits specialized updater.     |
| Nested keyed lists / nested conditionals              | ✅                   | Allowed as long as each level owns its anchors.                            |
| `ref` (callback/object)                               | ✅                   | Assigned after node creation; cleans up via root onDestroy callbacks.      |
| Custom components                                     | 🚫 (v1 out of scope) | Will continue routing through existing runtime entry points.               |
| Portals / slots / suspense                            | 🚫                   | Existing runtime helpers remain; no fine-grained lowering yet.             |

### Structural rules

1. **Static tree shape** – compiler must know the exact ordering of DOM nodes. All dynamic insertions happen via `createChildBinding`/`createKeyedList` derived helpers.
2. **Deterministic anchors** – every dynamic child receives a stable anchor comment (`const marker0 = document.createComment('...')`) wrapped in a `DocumentFragment` when returned as a binding handle, so callers can append `handle.marker` directly.
3. **Event handlers** – attached once via direct property assignment. Compiler is responsible for capturing dependencies via `createEffect` if the handler identity must change.
4. **Refs** – lowered to simple assignment after node creation; lifecycle coordination handled via root callbacks.

## 2. Runtime Helper API (frozen for Phase 0)

| Helper                  | Signature                                                                      | Purpose                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `bindText`              | `bindText(text: Text, getter: () => unknown): Cleanup`                         | Reactive text updates.                                                                                                     |
| `bindAttribute`         | `bindAttribute(el: HTMLElement, key: string, getter: () => unknown): Cleanup`  | Handles attr removal/boolean cases.                                                                                        |
| `bindStyle`             | `bindStyle(el: HTMLElement, getter: () => StyleValue): Cleanup`                | Applies string or object styles.                                                                                           |
| `bindClass`             | `bindClass(el: HTMLElement, getter: () => ClassValue): Cleanup`                | Normalizes string/object inputs.                                                                                           |
| `bindProperty`          | `bindProperty(el: HTMLElement, key: string, getter: () => unknown): Cleanup`   | Direct property wiring (e.g., value, checked).                                                                             |
| `insert`                | `insert(parent: Node, value: MaybeReactive<FictNode>, anchor?: Node            | null): void`                                                                                                               | Legacy child insertion; compiler still uses for dynamic child slots. |
| `createConditional`     | Returns `{ marker: DocumentFragment, dispose, flush }`                         | Truthy/falsy branch management; markers live inside the fragment so callers append `handle.marker` directly.               |
| `createKeyedList`       | Returns `{ marker: DocumentFragment, startMarker, endMarker, flush, dispose }` | High-level keyed list diffing; runtime defers diff until markers are mounted and reuses nodes via `createVersionedSignal`. |
| `moveMarkerBlock`       | `moveMarkerBlock(parent: Node, block: MarkerBlock, anchor: Node                | null): void`                                                                                                               | Moves start/end markers and enclosed nodes.                          |
| `destroyMarkerBlock`    | `destroyMarkerBlock(block: MarkerBlock): void`                                 | Tears down a marker range and destroys its root.                                                                           |
| `createVersionedSignal` | `createVersionedSignal<T>(value: T): VersionedSignal<T>`                       | Ensures same-reference writes still notify effects.                                                                        |

The above list is now frozen for Phase 2 implementation; compiler output may assume these helpers exist and remain backwards compatible.

## 3. Reference Code Generation Examples

### 3.1 Counter component

**Input JSX**

```tsx
function Counter() {
  const [count, setCount] = createSignal(0)
  return <button onClick={() => setCount(c => c + 1)}>Count: {count()}</button>
}
```

**Generated skeleton**

```ts
const el0 = document.createElement('button')
const txt0 = document.createTextNode('')
el0.append('Count: ', txt0)
el0.onclick = () => setCount(c => c + 1)
bindText(txt0, () => count())
```

### 3.2 Fragment with conditional child

**Input**

```tsx
<>
  <h1>{title()}</h1>
  {showDetails() ? <Details info={info()} /> : <Fallback />}
</>
```

**Output outline**

```ts
const fragChildren: Node[] = []
const el0 = document.createElement('h1')
const txt0 = document.createTextNode('')
el0.appendChild(txt0)
fragChildren.push(el0)
bindText(txt0, () => title())

const cond = createConditional(
  () => showDetails(),
  () => createElement(Details({ info: info() })),
  createElement,
  () => createElement(Fallback({})),
)
// cond.marker is a DocumentFragment containing start/end markers
fragChildren.push(cond.marker)
```

### 3.3 Keyed list with fine-grained blocks

**Input**

```tsx
<ul>
  {items().map(item => (
    <li key={item.id}>
      <span>{item.name}</span>
      <input value={item.value} />
    </li>
  ))}
</ul>
```

**Output outline**

```ts
const ul0 = document.createElement('ul')
const list = createKeyedListContainer()
// Compiler may append the high-level handle: createKeyedList(...).marker
// For low-level containers, append explicit markers:
ul0.append(list.startMarker, list.endMarker)

function mountItem(value: VersionedSignal<Item>, index: Signal<number>) {
  const root = createRootContext()
  const prev = pushRoot(root)
  const li = document.createElement('li')
  const span = document.createElement('span')
  const txt = document.createTextNode('')
  span.appendChild(txt)
  bindText(txt, () => value.read().name)
  const input = document.createElement('input')
  bindProperty(input, 'value', () => value.read().value)
  li.append(span, input)
  popRoot(prev)
  flushOnMount(root)
  return { nodes: [document.createComment('start'), li, document.createComment('end')], root }
}

function updateList(nextItems: Item[]) {
  // uses moveMarkerBlock/destroyMarkerBlock + createVersionedSignal
}
```

This document fulfills Phase 0 requirements: the supported JSX subset and helper API surface are now frozen, and the examples above serve as reference blueprints for the upcoming compiler work.
