# Multi-Priority Scheduler Technical Documentation

> Implementation details for Fict's dual-priority scheduling system

**Status**: Implemented in v0.x  
**Last Updated**: 2025-12-08

---

## Overview

Fict implements a dual-priority scheduler that allows marking certain updates as "low priority" (transitions), ensuring the UI remains responsive during expensive operations.

### Key Features

- **Dual-priority queue**: High-priority updates (user input) execute before low-priority updates (transitions)
- **Interruption support**: Low-priority work can be interrupted by incoming high-priority work
- **React-compatible API**: `startTransition`, `useTransition`, `useDeferredValue`
- **Zero additional dependencies**: Built on existing signal/effect infrastructure

---

## Architecture

### Queue Structure

```
┌─────────────────────────────────────────────────────────┐
│                    Scheduler                            │
├─────────────────────────────────────────────────────────┤
│  ┌─────────────────────┐  ┌─────────────────────────┐   │
│  │ highPriorityQueue   │  │ lowPriorityQueue        │   │
│  │ (user input, events)│  │ (transitions)           │   │
│  └─────────────────────┘  └─────────────────────────┘   │
│                    │                    │               │
│                    ▼                    ▼               │
│              ┌─────────────────────────────────┐        │
│              │           flush()               │        │
│              │  1. Process all high priority   │        │
│              │  2. Process low priority        │        │
│              │     (interruptible)             │        │
│              └─────────────────────────────────┘        │
└─────────────────────────────────────────────────────────┘
```

### Flow Diagram

```
Signal Write ─┬─ isInTransition=false ──▶ highPriorityQueue
              │
              └─ isInTransition=true ───▶ lowPriorityQueue
                                                │
                                                ▼
                                         scheduleFlush()
                                                │
                                                ▼
                                         microtask flush()
                                                │
                    ┌───────────────────────────┴───────────────────────────┐
                    ▼                                                       ▼
            Process highPriorityQueue                              Process lowPriorityQueue
            (all effects)                                          (interruptible)
                                                                          │
                                                            Check: highPriorityQueue.length > 0?
                                                                          │
                                                           ┌──────────────┴──────────────┐
                                                           ▼                              ▼
                                                    YES: scheduleFlush()            NO: continue
                                                         and return
```

---

## Implementation Details

### Modified Files

| File                                 | Changes                 |
| ------------------------------------ | ----------------------- |
| `packages/runtime/src/signal.ts`     | Core scheduler changes  |
| `packages/runtime/src/transition.ts` | New API implementations |
| `packages/runtime/src/scheduler.ts`  | Export additions        |
| `packages/runtime/src/index.ts`      | Public exports          |

### Core Changes in `signal.ts`

#### 1. Global State Changes

```typescript
// Before: Single queue
let notifyIndex = 0
let queuedLength = 0
const queued: (EffectNode | undefined)[] = []

// After: Dual-priority queues
const highPriorityQueue: EffectNode[] = []
const lowPriorityQueue: EffectNode[] = []
let isInTransition = false
```

#### 2. Modified `notify()` Function

Routes effects to the appropriate queue based on transition context:

```typescript
function notify(effect: ReactiveNode): void {
  effect.flags &= ~Watching
  const effects: EffectNode[] = []

  for (;;) {
    effects.push(effect as EffectNode)
    const nextLink = effect.subs
    if (nextLink === undefined) break
    effect = nextLink.sub
    if (effect === undefined || !(effect.flags & Watching)) break
    effect.flags &= ~Watching
  }

  // Reverse to maintain correct execution order
  effects.reverse()

  // Route effects to appropriate queue based on transition context
  const targetQueue = isInTransition ? lowPriorityQueue : highPriorityQueue
  for (const e of effects) {
    targetQueue.push(e)
  }
}
```

#### 3. Modified `flush()` Function

Processes queues with priority and supports interruption:

```typescript
function flush(): void {
  beginFlushGuard()

  if (batchDepth > 0) {
    scheduleFlush()
    endFlushGuard()
    return
  }

  const hasWork = highPriorityQueue.length > 0 || lowPriorityQueue.length > 0
  if (!hasWork) {
    flushScheduled = false
    endFlushGuard()
    return
  }

  flushScheduled = false

  // 1. Process all high-priority effects first
  while (highPriorityQueue.length > 0) {
    const e = highPriorityQueue.shift()!
    if (!beforeEffectRunGuard()) {
      endFlushGuard()
      return
    }
    runEffect(e)
  }

  // 2. Process low-priority effects, interruptible by high priority
  while (lowPriorityQueue.length > 0) {
    // Check if high priority work arrived during low priority execution
    if (highPriorityQueue.length > 0) {
      scheduleFlush()
      endFlushGuard()
      return
    }
    const e = lowPriorityQueue.shift()!
    if (!beforeEffectRunGuard()) {
      endFlushGuard()
      return
    }
    runEffect(e)
  }

  endFlushGuard()
}
```

#### 4. Transition Context Helpers

```typescript
export function setTransitionContext(value: boolean): boolean {
  const prev = isInTransition
  isInTransition = value
  return prev
}

export function getTransitionContext(): boolean {
  return isInTransition
}
```

---

## API Reference

### `startTransition(fn: () => void): void`

Executes a function with low-priority scheduling.

**Parameters:**

- `fn` - The function to execute in transition context

**Example:**

```tsx
const handleInput = e => {
  query = e.target.value // High priority: immediate
  startTransition(() => {
    // Low priority: processed after high priority updates
    filteredItems = allItems.filter(x => x.includes(query))
  })
}
```

**Implementation:**

```typescript
export function startTransition(fn: () => void): void {
  const prev = setTransitionContext(true)
  try {
    fn()
  } finally {
    setTransitionContext(prev)
    scheduleFlush()
  }
}
```

---

### `useTransition(): [() => boolean, (fn: () => void) => void]`

Returns a pending signal and a startTransition function.

**Returns:**

- `[isPending, start]` - Tuple of pending accessor and start function

**Example:**

```tsx
function SearchComponent() {
  let query = $state('')
  const [isPending, start] = useTransition()

  const handleChange = e => {
    query = e.target.value
    start(() => {
      filteredResults = expensiveFilter(allData, query)
    })
  }

  return (
    <>
      <input value={query} onInput={handleChange} />
      {isPending() && <Spinner />}
      <Results items={filteredResults} />
    </>
  )
}
```

**Implementation:**

```typescript
export function useTransition(): [() => boolean, (fn: () => void) => void] {
  const pending = signal(false)

  const start = (fn: () => void) => {
    pending(true)
    startTransition(() => {
      try {
        fn()
      } finally {
        pending(false)
      }
    })
  }

  return [() => pending(), start]
}
```

---

### `useDeferredValue<T>(getValue: () => T): () => T`

Creates a deferred version of a value that updates with low priority.

**Parameters:**

- `getValue` - Accessor function that returns the source value

**Returns:**

- Accessor function that returns the deferred value

**Example:**

```tsx
function SearchResults({ query }) {
  const deferredQuery = useDeferredValue(() => query)
  const results = expensiveSearch(deferredQuery())
  return <ResultList items={results} />
}
```

**Implementation:**

```typescript
export function useDeferredValue<T>(getValue: () => T): () => T {
  const deferredValue = signal(getValue())

  createEffect(() => {
    const newValue = getValue()
    if (deferredValue() !== newValue) {
      startTransition(() => {
        deferredValue(newValue)
      })
    }
  })

  return () => deferredValue()
}
```

---

## Testing

### Test File Location

`packages/runtime/src/__tests__/scheduler.test.ts`

### Test Coverage

| Test Suite       | Tests | Description                             |
| ---------------- | ----- | --------------------------------------- |
| Priority Queue   | 2     | Verifies high-priority-first execution  |
| startTransition  | 2     | Tests low-priority marking and batching |
| useTransition    | 2     | Tests pending state and start function  |
| useDeferredValue | 2     | Tests deferred value behavior           |
| Integration      | 1     | Tests compatibility with batch          |

### Running Tests

```bash
pnpm --filter fict-runtime test
```

Expected output:

```
Test Files  19 passed (19)
Tests       213 passed (213)
```

---

## Usage Patterns

### Pattern 1: Search Input with Filtering

```tsx
function Search() {
  let query = $state('')
  let results = $state([])

  const handleInput = e => {
    // Immediate: update input value
    query = e.target.value

    // Deferred: expensive filtering
    startTransition(() => {
      results = allItems.filter(item => item.toLowerCase().includes(query.toLowerCase()))
    })
  }

  return (
    <div>
      <input value={query} onInput={handleInput} />
      <ul>
        {results.map(item => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  )
}
```

### Pattern 2: Tab Switching with Loading State

```tsx
function Tabs() {
  let activeTab = $state(0)
  const [isPending, start] = useTransition()

  const switchTab = index => {
    start(() => {
      activeTab = index
    })
  }

  return (
    <div>
      <nav style={{ opacity: isPending() ? 0.7 : 1 }}>
        <button onClick={() => switchTab(0)}>Tab 1</button>
        <button onClick={() => switchTab(1)}>Tab 2</button>
      </nav>
      <TabContent index={activeTab} />
    </div>
  )
}
```

### Pattern 3: Deferred Heavy Computation

```tsx
function DataVisualization({ data }) {
  // Immediate data reference
  const rawData = () => data

  // Deferred for expensive chart calculations
  const deferredData = useDeferredValue(rawData)

  // Expensive computation uses deferred value
  const chartConfig = computeChartConfig(deferredData())

  return <Chart config={chartConfig} />
}
```

---

## Future Considerations

### Not Implemented (Phase 3)

The following features were considered but deferred:

1. **Time Slicing**: Using `requestIdleCallback` or `MessageChannel` to break up work
2. **Frame Budget**: Yielding after ~5ms to maintain 60fps
3. **Priority Lanes**: Multiple priority levels beyond high/low

**Rationale**: Fict's fine-grained reactivity already produces small updates. These features add complexity without proven benefit for typical use cases.

### Potential Enhancements

- `beforeFlush` / `afterFlush` hooks for DevTools
- Queue length monitoring APIs
- Custom scheduler injection point

---

## Related Documentation

- [API Documentation](../packages/docs-site/docs/api/transition.md)
- [Architecture Overview](./architecture.md)
- [Framework Comparison](./framework-comparison.md)
