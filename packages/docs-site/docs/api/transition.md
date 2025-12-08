# Transition API

> Priority scheduling for smooth UI updates

Fict provides transition APIs to mark certain updates as lower priority, keeping the UI responsive during expensive operations.

## startTransition

Marks updates as low priority. High-priority updates (like user input) will execute first.

```tsx
import { startTransition } from 'fict'

function SearchComponent() {
  let query = $state('')
  let results = $state([])

  const handleInput = e => {
    // High priority: updates input immediately
    query = e.target.value

    // Low priority: filtering can be interrupted
    startTransition(() => {
      results = expensiveFilter(allData, query)
    })
  }

  return (
    <>
      <input value={query} onInput={handleInput} />
      <ResultList items={results} />
    </>
  )
}
```

## useTransition

Returns a pending signal and a start function. Useful for showing loading indicators during transitions.

```tsx
import { useTransition } from 'fict'

function SearchComponent() {
  let query = $state('')
  let results = $state([])
  const [isPending, start] = useTransition()

  const handleInput = e => {
    query = e.target.value

    start(() => {
      results = expensiveFilter(allData, query)
    })
  }

  return (
    <>
      <input value={query} onInput={handleInput} />
      {isPending() && <Spinner />}
      <ResultList items={results} />
    </>
  )
}
```

## useDeferredValue

Creates a deferred version of a value that updates with low priority. The deferred value will lag behind during rapid updates.

```tsx
import { useDeferredValue } from 'fict'

function SearchResults({ query }) {
  // deferredQuery lags behind query during rapid typing
  const deferredQuery = useDeferredValue(() => query)

  // Expensive computation uses deferred value
  const results = expensiveSearch(deferredQuery())

  return <ResultList items={results} />
}
```

## How It Works

Fict uses a dual-priority queue system:

1. **High Priority Queue**: Normal updates (user input, events)
2. **Low Priority Queue**: Updates marked via transition APIs

During flush:

- High priority effects run first
- Low priority effects can be interrupted if new high priority work arrives

This keeps the main thread responsive without requiring manual optimization.

## API Reference

| Function           | Signature                                                           | Description                          |
| ------------------ | ------------------------------------------------------------------- | ------------------------------------ |
| `startTransition`  | `(fn: () => void) => void`                                          | Execute function with low priority   |
| `useTransition`    | `() => [isPending: () => boolean, start: (fn: () => void) => void]` | Get pending state and start function |
| `useDeferredValue` | `<T>(getValue: () => T) => () => T`                                 | Create deferred value accessor       |
