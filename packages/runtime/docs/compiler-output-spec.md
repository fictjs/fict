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

### Expected Output (Target)

```typescript
import {
  createSignal as __fictSignal,
  createEffect as __fictEffect,
  createKeyedListContainer,
  createKeyedBlock,
  moveNodesBefore,
  removeNodes,
  getFirstNodeAfter,
} from '@fictjs/runtime'

let [items, setItems] = __fictSignal([
  { id: 1, name: 'Alice' },
  { id: 2, name: 'Bob' },
  { id: 3, name: 'Charlie' },
])

const el = document.createElement('ul')

// Create list container
const __listContainer = createKeyedListContainer()
el.appendChild(__listContainer.startMarker)
el.appendChild(__listContainer.endMarker)

// Effect to manage list updates
__fictEffect(() => {
  const newItems = items()
  const oldBlocks = __listContainer.blocks
  const newBlocks = new Map()

  // Build new blocks map
  newItems.forEach((item, index) => {
    const key = item.id
    let block = oldBlocks.get(key)

    if (block) {
      // Reuse existing block - update signals
      block.item(item)
      block.index(index)
      newBlocks.set(key, block)
      oldBlocks.delete(key)
    } else {
      // Create new block
      block = createKeyedBlock(key, item, index, (itemSig, indexSig) => {
        const li = document.createElement('li')
        __fictEffect(() => {
          li.textContent = itemSig().name
        })
        return [li]
      })
      newBlocks.set(key, block)
    }
  })

  // Remove old blocks
  for (const block of oldBlocks.values()) {
    destroyRoot(block.root)
    removeNodes(block.nodes)
  }

  // Reorder DOM nodes
  let anchor = getFirstNodeAfter(__listContainer.startMarker)
  for (const [key] of newBlocks) {
    const block = newBlocks.get(key)!
    const firstNode = block.nodes[0]

    if (firstNode !== anchor) {
      moveNodesBefore(el, block.nodes, anchor)
    }

    // Move anchor past this block's nodes
    anchor = block.nodes[block.nodes.length - 1].nextSibling
  }

  __listContainer.blocks = newBlocks
})
```

## Simplified Output (Phase 1 - Runtime Helper)

For Phase 1, we can create a higher-level runtime helper that encapsulates this logic:

### New Runtime Helper: `createKeyedList`

```typescript
// In runtime/src/list-helpers.ts
export function createKeyedList<T>(
  getItems: () => T[],
  keyFn: (item: T, index: number) => string | number,
  renderItem: (itemSig: Signal<T>, indexSig: Signal<number>) => Node[],
): KeyedListBinding {
  const container = createKeyedListContainer<T>()

  const updateEffect = createEffect(() => {
    const newItems = getItems()
    const oldBlocks = container.blocks
    const newBlocks = new Map<string | number, KeyedBlock<T>>()

    // Keyed diff algorithm
    newItems.forEach((item, index) => {
      const key = keyFn(item, index)
      let block = oldBlocks.get(key)

      if (block) {
        // Reuse and update
        block.item(item)
        block.index(index)
        newBlocks.set(key, block)
        oldBlocks.delete(key)
      } else {
        // Create new
        block = createKeyedBlock(key, item, index, renderItem)
        newBlocks.set(key, block)

        // Insert into DOM (initially at end)
        insertNodesBefore(container.endMarker.parentNode!, block.nodes, container.endMarker)
      }
    })

    // Remove old blocks
    for (const block of oldBlocks.values()) {
      destroyRoot(block.root)
      removeNodes(block.nodes)
    }

    // Reorder DOM to match new order
    if (container.endMarker.parentNode) {
      let anchor: Node | null = getFirstNodeAfter(container.startMarker)

      for (const key of Array.from(newBlocks.keys())) {
        const block = newBlocks.get(key)!
        const firstNode = block.nodes[0]

        if (firstNode !== anchor) {
          moveNodesBefore(container.endMarker.parentNode, block.nodes, anchor)
        }

        // Move anchor to after this block
        anchor = block.nodes[block.nodes.length - 1].nextSibling
      }
    }

    container.blocks = newBlocks
  })

  return {
    startMarker: container.startMarker,
    endMarker: container.endMarker,
    dispose: () => {
      updateEffect.dispose?.()
      container.dispose()
    },
  }
}

export interface KeyedListBinding {
  startMarker: Comment
  endMarker: Comment
  dispose: () => void
}
```

### Compiler Output Using createKeyedList

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
)

el.appendChild(__list.startMarker)
el.appendChild(__list.endMarker)
```

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
// Already defined in list-helpers.ts
export interface KeyedBlock<T = unknown> {
  key: string | number
  nodes: Node[]
  root: RootContext
  item: Signal<T>
  index: Signal<number>
}

export interface KeyedListContainer<T = unknown> {
  startMarker: Comment
  endMarker: Comment
  blocks: Map<string | number, KeyedBlock<T>>
  dispose: () => void
}

export interface KeyedListBinding {
  startMarker: Comment
  endMarker: Comment
  dispose: () => void
}

// Compiler-generated code uses these:
export type KeyFn<T> = (item: T, index: number) => string | number
export type RenderItemFn<T> = (itemSig: Signal<T>, indexSig: Signal<number>) => Node[]
```

## Compiler Implementation Phases

### Phase 1: Runtime Helper (Week 2)

1. Implement `createKeyedList` helper in runtime
2. Export it from index.ts
3. Write comprehensive tests

### Phase 2: Compiler Detection (Week 6)

1. Detect `.map()` calls in JSX with `key` attributes
2. Extract key expression from `key={...}`
3. Generate `createKeyedList` calls

### Phase 3: Optimization (Week 7)

1. Inline simple key functions
2. Optimize known patterns (e.g., `key={item}` for primitives)
3. Warn on missing keys

### Phase 4: Advanced Features (Week 8)

1. Handle conditional items within lists
2. Support nested lists
3. Optimize with fallback to index when appropriate

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

Existing code using the old `createList` helper will continue to work. The compiler will:

1. Detect `key` attribute presence
2. If present: use new `createKeyedList`
3. If absent: use old `createList` (or warn and fallback)

This allows gradual migration and backwards compatibility.

## Performance Considerations

### Expected Performance Characteristics

- **Reorder**: O(n) DOM operations for n items
- **Add**: O(1) per new item
- **Remove**: O(1) per removed item
- **Update**: O(0) DOM operations (signals update in place)

### Compared to Full Rebuild

Old approach with `createList` (full rebuild):

- Any change: O(n) destroy + O(n) create = O(2n)

New approach with `createKeyedList`:

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
