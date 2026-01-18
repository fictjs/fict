# Cycle Protection

Fict includes built-in cycle protection to help developers identify and prevent infinite reactive loops during development. This feature detects runaway effects and provides early warnings before they can crash the application.

## Overview

Reactive systems can accidentally create infinite loops when:

- An effect updates a signal that it depends on
- Multiple effects form a circular dependency chain
- Component re-renders trigger effects that cause more re-renders

Fict's cycle protection monitors these patterns and provides helpful warnings in development mode.

## When Cycle Protection Activates

Cycle protection is **only active in development mode** (`NODE_ENV !== 'production'`). In production, the guards are no-ops for maximum performance.

Detection triggers in three scenarios:

| Trigger                   | Description                                                              |
| ------------------------- | ------------------------------------------------------------------------ |
| **Flush Budget Exceeded** | Too many effects ran in a single microtask flush                         |
| **Root Re-entry Depth**   | A root context was re-entered too deeply (recursive component execution) |
| **High Usage Window**     | Multiple consecutive flush cycles used a high percentage of the budget   |

## API Reference

### `setCycleProtectionOptions`

Configure cycle protection thresholds and behavior.

```typescript
import { setCycleProtectionOptions } from 'fict/advanced'

interface CycleProtectionOptions {
  /** Maximum effect runs allowed per microtask flush (default: 10,000) */
  maxFlushCyclesPerMicrotask?: number

  /** Maximum effect runs per flush (default: 20,000) */
  maxEffectRunsPerFlush?: number

  /** Number of flushes to track for high-usage detection (default: 5) */
  windowSize?: number

  /** Ratio threshold for high-usage warning (default: 0.8 = 80%) */
  highUsageRatio?: number

  /** Maximum root re-entry depth before warning (default: 10) */
  maxRootReentrantDepth?: number

  /** Whether to warn about sustained high usage patterns (default: true) */
  enableWindowWarning?: boolean

  /** If true, throw errors instead of warnings (useful for testing) */
  devMode?: boolean
}

setCycleProtectionOptions(options: CycleProtectionOptions): void
```

**Example:**

```tsx
import { setCycleProtectionOptions } from 'fict/advanced'

// Increase limits for a large application
setCycleProtectionOptions({
  maxFlushCyclesPerMicrotask: 50000,
  maxEffectRunsPerFlush: 100000,
})

// Strict mode for testing - throw errors instead of warnings
setCycleProtectionOptions({
  devMode: true,
  maxFlushCyclesPerMicrotask: 100,
})
```

---

## Configuration Options

### `maxFlushCyclesPerMicrotask`

**Default:** `10,000`

Maximum number of effect runs allowed within a single microtask flush. If exceeded, cycle protection will warn (or throw in devMode) and stop processing further effects.

**When to adjust:**

- Increase for large applications with many reactive computations
- Decrease for stricter cycle detection during development

```tsx
// Large app with complex reactive graph
setCycleProtectionOptions({
  maxFlushCyclesPerMicrotask: 50000,
})

// Strict development mode
setCycleProtectionOptions({
  maxFlushCyclesPerMicrotask: 100,
})
```

---

### `maxEffectRunsPerFlush`

**Default:** `20,000`

Similar to `maxFlushCyclesPerMicrotask`, but tracks total effect runs across the flush. This provides a secondary limit.

---

### `windowSize`

**Default:** `5`

Number of consecutive flush cycles to track for high-usage pattern detection. The window tracks how much of the budget each flush used.

---

### `highUsageRatio`

**Default:** `0.8` (80%)

When all flushes in the window use more than this ratio of their budget, a warning is triggered. This helps detect sustained high load that might indicate a performance problem.

**Example:**

If `windowSize` is 5 and `highUsageRatio` is 0.8, a warning triggers when 5 consecutive flushes each use 80% or more of the budget.

```tsx
// More sensitive to sustained high usage
setCycleProtectionOptions({
  windowSize: 3,
  highUsageRatio: 0.6, // Warn at 60% usage over 3 flushes
})
```

---

### `maxRootReentrantDepth`

**Default:** `10`

Maximum depth of nested root context re-entry. This detects recursive component execution patterns that could indicate infinite loops.

```tsx
// Stricter recursive detection
setCycleProtectionOptions({
  maxRootReentrantDepth: 5,
})
```

---

### `enableWindowWarning`

**Default:** `true`

Toggle the high-usage window warning. Set to `false` to disable sustained usage warnings while keeping other protections active.

```tsx
// Disable sustained usage warnings
setCycleProtectionOptions({
  enableWindowWarning: false,
})
```

---

### `devMode`

**Default:** `false`

When `true`, cycle protection throws errors instead of logging warnings. Useful for:

- Unit tests that should fail on cycle detection
- Strict development environments
- CI/CD pipelines

```tsx
// For testing - fail fast on cycles
setCycleProtectionOptions({
  devMode: true,
  maxFlushCyclesPerMicrotask: 100,
})
```

---

## DevTools Integration

Cycle protection integrates with the Fict DevTools hook. When a cycle is detected, the `cycleDetected` method is called with details:

```typescript
interface CycleDetectedPayload {
  reason: 'flush-budget-exceeded' | 'root-reentry' | 'high-usage-window'
  detail?: {
    effectRuns?: number
    depth?: number
    windowSize?: number
    ratio?: number
  }
}
```

DevTools can subscribe to these events for enhanced debugging visualization.

---

## Common Patterns and Solutions

### Pattern 1: Effect Updates Its Own Dependency

**Problem:**

```tsx
function Counter() {
  let count = $state(0)

  // ❌ Infinite loop: effect reads and writes count
  $effect(() => {
    console.log(count)
    count++ // Updates count, which re-triggers the effect
  })

  return <div>{count}</div>
}
```

**Solution:**

```tsx
function Counter() {
  let count = $state(0)

  // ✅ Use untrack to break the dependency
  $effect(() => {
    const current = count // Track read
    console.log(current)
    // Don't update the same signal in the effect
  })

  return <div>{count}</div>
}
```

---

### Pattern 2: Cascading Effect Updates

**Problem:**

```tsx
function Form() {
  let a = $state(0)
  let b = $state(0)

  // ❌ Effects trigger each other
  $effect(() => {
    b = a + 1
  })

  $effect(() => {
    a = b + 1
  })

  return (
    <div>
      {a} {b}
    </div>
  )
}
```

**Solution:**

```tsx
function Form() {
  let a = $state(0)

  // ✅ Compute derived value instead of circular effects
  const b = a + 1 // Automatically derived

  return (
    <div>
      {a} {b}
    </div>
  )
}
```

---

### Pattern 3: Effect Causes Component Re-execution

**Problem:**

```tsx
function List() {
  let items = $state([])

  // ❌ Effect runs fetch which updates items, triggering re-execution
  $effect(() => {
    fetch('/api/items')
      .then(r => r.json())
      .then(data => {
        items = data // This can cause re-execution if items is read in control flow
      })
  })

  if (items.length > 0) {
    // Reading items in control flow...
  }

  return (
    <ul>
      {items.map(i => (
        <li key={i.id}>{i.name}</li>
      ))}
    </ul>
  )
}
```

**Solution:**

```tsx
import { resource } from 'fict/plus'

// ✅ Use resource for data fetching
const itemsResource = resource(async ({ signal }) => {
  const res = await fetch('/api/items', { signal })
  return res.json()
})

function List() {
  const items = itemsResource.read()

  if (items.loading) return <div>Loading...</div>

  return (
    <ul>
      {items.data?.map(i => (
        <li key={i.id}>{i.name}</li>
      ))}
    </ul>
  )
}
```

---

## Testing with Cycle Protection

For unit tests, enable strict mode to fail fast on cycle detection:

```tsx
import { describe, it, expect, afterEach } from 'vitest'
import { setCycleProtectionOptions } from 'fict/advanced'
import { resetCycleProtectionStateForTests } from 'fict/internal'

describe('Reactive Tests', () => {
  afterEach(() => {
    // Reset state between tests
    resetCycleProtectionStateForTests()
  })

  it('should not create infinite loops', () => {
    setCycleProtectionOptions({
      devMode: true,
      maxFlushCyclesPerMicrotask: 100,
    })

    // Test code...
    // Will throw if cycle is detected
  })
})
```

---

## Warning Messages

Cycle protection warnings follow this format:

```
[fict] cycle protection triggered: <reason>
```

| Reason                  | Description                                |
| ----------------------- | ------------------------------------------ |
| `flush-budget-exceeded` | Too many effects ran in one flush          |
| `root-reentry`          | Root context re-entered too deeply         |
| `high-usage-window`     | Sustained high usage over multiple flushes |

Each warning includes context to help identify the issue:

```javascript
// Example warning output
[fict] cycle protection triggered: flush-budget-exceeded { effectRuns: 10001 }
[fict] cycle protection triggered: root-reentry { depth: 11 }
[fict] cycle protection triggered: high-usage-window { windowSize: 5, ratio: 0.8 }
```

---

## Production Behavior

In production (`NODE_ENV === 'production'`):

- All cycle protection guards are no-ops
- Zero runtime overhead
- No warnings are emitted
- Application continues even if cycles would occur

This ensures maximum performance while providing safety during development.

---

## Best Practices

1. **Keep default settings for most applications** - The defaults are tuned for typical use cases

2. **Enable devMode in tests** - Catch cycles early in your test suite

3. **Don't suppress warnings** - Cycle warnings indicate real problems

4. **Use derived values instead of circular effects** - Let the compiler handle dependencies

5. **Use `resource` for async data** - Avoids effect/state update cycles

6. **Review high-usage warnings** - They may indicate performance issues even if not infinite loops

---

## See Also

- [Architecture](./architecture.md) - How Fict's reactive system works
- [Reactivity Semantics](./reactivity-semantics.md) - Rules of the reactive system
- [API Reference](./api-reference.md) - Complete API documentation
