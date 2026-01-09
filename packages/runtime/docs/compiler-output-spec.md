# Compiler Output Specification for Fine-Grained List Rendering

This document defines the expected output format from the Fict compiler when transforming JSX lists into fine-grained reactive code using the list-helpers primitives.

## Overview

The compiler will transform JSX list expressions (`.map()` calls with `key` attributes) into imperative code that uses the list-helpers primitives for efficient keyed diffing and DOM node reuse.

## Core Transformation Strategy

### Input JSX Pattern

```jsx
import { $state } from 'fict'

let items = $state([
  { id: 1, name: 'Alice' },
  { id: 2, name: 'Bob' },
  { id: 3, name: 'Charlie' },
])

const el = (
  <ul>
    {items.map(item => (
      <li key={item.id}>{item.name}</li>
    ))}
  </ul>
)
```

### Expected Output

```typescript
import {
  createSignal as __fictSignal,
  createEffect as __fictEffect,
  createKeyedList,
} from '@fictjs/runtime'

let [items, setItems] = __fictSignal([
  { id: 1, name: 'Alice' },
  { id: 2, name: 'Bob' },
  { id: 3, name: 'Charlie' },
])

const el = document.createElement('ul')

const __list = createKeyedList(
  () => items(),
  item => item.id,
  (itemSig, indexSig) => {
    const li = document.createElement('li')
    __fictEffect(() => {
      li.textContent = itemSig().name
    })
    return [li]
  },
  false,
)

el.appendChild(__list.marker)
__list.flush?.()
```

The compiler emits the final boolean argument to indicate whether the map callback uses an index
parameter. The runtime uses it to skip unnecessary index writes.

## Key Extraction Rules

### 1. Explicit `key` Attribute (Preferred)

```jsx
items.map(item => <li key={item.id}>{item.name}</li>)
```

Compiler extracts: `(item) => item.id`

### 2. Explicit `key` with Index

```jsx
items.map((item, i) => <li key={`${item.id}-${i}`}>{item.name}</li>)
```

Compiler extracts: `(item, i) => `${item.id}-${i}``

### 3. No `key` Attribute (Fallback to Index)

```jsx
items.map(item => <li>{item.name}</li>)
```

Compiler generates: `(item, i) => i`

**Warning**: Index as key disables proper keyed diff benefits.

## Multiple Nodes per Item

When the map callback returns multiple adjacent nodes:

```jsx
items.map(item => (
  <>
    <dt key={item.id}>{item.name}</dt>
    <dd>{item.description}</dd>
  </>
))
```

Output:

```typescript
createKeyedList(
  () => items(),
  item => item.id,
  (itemSig, indexSig) => {
    const dt = document.createElement('dt')
    const dd = document.createElement('dd')

    __fictEffect(() => {
      dt.textContent = itemSig().name
      dd.textContent = itemSig().description
    })

    return [dt, dd] // Multiple nodes in array
  },
)
```

## Nested Reactive Expressions

When list items contain nested reactive expressions:

```jsx
let multiplier = $state(2)
let items = $state([1, 2, 3])

const list = items.map(item => <li key={item}>{item * multiplier}</li>)
```

Output:

```typescript
const [multiplier, setMultiplier] = __fictSignal(2)
const [items, setItems] = __fictSignal([1, 2, 3])

const __list = createKeyedList(
  () => items(),
  item => item,
  (itemSig, indexSig) => {
    const li = document.createElement('li')
    __fictEffect(() => {
      // Both itemSig and multiplier are reactive
      li.textContent = String(itemSig() * multiplier())
    })
    return [li]
  },
)
```

## Type Definitions

```typescript
export interface KeyedListBinding {
  marker: DocumentFragment
  startMarker: Comment
  endMarker: Comment
  flush?: () => void
  dispose: () => void
}

// Compiler-generated code uses these:
type KeyFn<T> = (item: T, index: number) => string | number
type RenderItemFn<T> = (
  itemSig: Signal<T>,
  indexSig: Signal<number>,
  key: string | number,
) => Node[]
```

## Testing Strategy

### Unit Tests (Runtime)

- Test createKeyedList with simple arrays
- Test add/remove/reorder operations
- Test key collisions
- Test cleanup and dispose

### Integration Tests (Compiler)

- Test JSX transformation produces correct calls
- Test key extraction from various patterns
- Test nested reactive expressions in list items

### E2E Tests

- Test actual DOM updates are minimal
- Test state preservation during reordering
- Test performance with large lists

## Migration Path

Compiler output always uses `createKeyedList` for mapped JSX. When no explicit key is provided, it falls back to an index-based key function (and surfaces `FICT-J002` to encourage explicit keys). The legacy `createList` helper has been removed; hand-written code should call `createKeyedList` directly.

## Performance Considerations

### Expected Performance Characteristics

- **Reorder**: O(n) DOM operations for n items
- **Add**: O(1) per new item
- **Remove**: O(1) per removed item
- **Update**: O(0) DOM operations (signals update in place)

### Compared to Full Rebuild

Fine-grained keyed list (`createKeyedList`, used for keyed and unkeyed lists alike):

- Reorder: O(n) moves
- Update: O(0) (signals update existing nodes)
- Add/Remove: O(k) where k = changed items

### Memory

Each list item requires:

- 2 Signals (item, index)
- 1 RootContext
- 1 Array of nodes
- Additional effect overhead

Acceptable for typical UI lists (<1000 items).
