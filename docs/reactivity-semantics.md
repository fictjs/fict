# Fict Reactivity Semantics

This document defines the semantic contract between Fict developers and the compiler. It explains **"when you write this, Fict does that"** — the predictable rules that govern how your code behaves.

## Core Principle: Getter-Based Reactivity

Fict's compiler transforms all reactive value access into **getter calls**. This single principle solves most "implicit semantics" problems elegantly:

```js
// Source
let count = $state(0)
console.log(count)

// Compiled (conceptual)
const [count, setCount] = signal(0)
console.log(count()) // ← getter call
```

---

## Rule 1: Sink-Driven Reactivity

**Only values that flow to "reactive sinks" become memos.**

Reactive sinks include:

- JSX expressions (`<div>{value}</div>`)
- `$effect` bodies
- DOM bindings

| Pattern               | Used in JSX/effect          | Used only in plain JS      |
| --------------------- | --------------------------- | -------------------------- |
| `const x = count`     | → memo (`x()`)              | → snapshot (`x = count()`) |
| `const x = count * 2` | → memo                      | → snapshot                 |
| `const x = a + b`     | → memo (if a or b reactive) | → snapshot                 |

### Example

```js
// Source
let count = $state(0)
const doubled = count * 2
const tripled = count * 3

console.log(tripled) // tripled is snapshot (plain JS only)
return <div>{doubled}</div> // doubled becomes memo (used in JSX)
```

### Why This Matters

This design avoids turning every intermediate variable into a reactive node. Only values that actually need reactivity get it — keeping the reactive graph minimal and performant.

---

## Rule 2: Closures Always Read Latest Value

Closures that capture reactive values are transformed to read via getter. The closure itself remains **stable** (no recreation).

```js
// Source
let count = $state(0)
const onClick = () => console.log(count)

// Compiled (conceptual)
const onClick = () => console.log(count()) // reads latest value each call
// onClick reference is stable — never recreated
```

### Implications

- Event handlers are stable references
- No need for `useCallback` or `stableCallback`
- Each handler invocation reads the current value

---

## Rule 3: Call-Site Expansion

Function arguments expand to getter calls at the call site. **No cross-function analysis needed.**

```js
// Source
function compute(x) {
  return x * 2
}
let count = $state(0)
const result = compute(count)

// Compiled (conceptual)
function compute(x) {
  return x * 2
} // unchanged
const result = compute(count()) // getter called at call site
```

### Why This Works

The callee receives a plain value. Reactivity is handled by the caller expanding the getter. This is simpler and more predictable than trying to infer purity across function boundaries.

---

## Rule 4: Props Destructuring Stays Reactive

Destructured props are automatically converted to reactive getters via `useProp`.

```js
// Source
function Component({ count, name }) {
  const doubled = count * 2
  return (
    <div>
      {name}: {doubled}
    </div>
  )
}

// Compiled (conceptual)
function Component(__props) {
  const count = useProp(() => __props.count)
  const name = useProp(() => __props.name)
  const doubled = memo(() => count() * 2)
  // ...
}
```

### Key Point

Destructuring props **does not** create snapshots. Each destructured field becomes a reactive getter that tracks the parent prop.

---

## Rule 5: Dynamic Property Access Granularity

| Access Pattern          | Tracking Granularity              |
| ----------------------- | --------------------------------- |
| `obj.a.b`               | Fine-grained (tracks `a` and `b`) |
| `obj[dynamicKey]`       | Coarse (tracks entire `obj`)      |
| `Reflect.get(obj, key)` | Coarse (tracks entire `obj`)      |

### Example

```js
let data = $state({ a: 1, b: 2 })

// Fine-grained: only re-runs when data.a changes
const x = data.a

// Coarse: re-runs when any property of data changes
const key = 'a'
const y = data[key]
```

### Recommendation

Prefer static property access when possible for optimal update granularity.

---

## Rule 6: Control Flow Is Native JavaScript

Fict supports native JS control flow — no special components needed.

```js
// This works exactly as expected
let show = $state(true)
let items = $state([1, 2, 3])

return (
  <div>
    {show && <Panel />}
    {items.map(item => (
      <Item key={item.id} data={item} />
    ))}
  </div>
)
```

Control flow conditions that read reactive values automatically trigger re-evaluation when those values change.

---

## Compilation Before/After Reference

### Basic Derived Value

```js
// Source
let count = $state(0)
const doubled = count * 2
return <div>{doubled}</div>

// Compiled
const count = __fictUseSignal(__fictCtx, 0)
const doubled = __fictUseMemo(__fictCtx, () => count() * 2)
// ... bindText(node, () => doubled())
```

### Event Handler

```js
// Source
let count = $state(0)
const handleClick = () => count++

// Compiled
const count = __fictUseSignal(__fictCtx, 0)
const handleClick = () => count(count() + 1)
// handleClick is stable — defined once
```

### Conditional Rendering

```js
// Source
let show = $state(true)
return show ? <A /> : <B />

// Compiled
// Fict generates efficient conditional that only
// swaps components when show() changes
```

### List Rendering

```js
// Source
let items = $state([...])
return items.map(item => <Li key={item.id}>{item.name}</Li>)

// Compiled
// Fict generates keyed list reconciliation
// Each item access becomes item() getter
```

---

## Quick Reference: What Works

| Pattern                | Support | Notes                                    |
| ---------------------- | ------- | ---------------------------------------- |
| `const x = count`      | ✅      | Memo if used in sink, snapshot otherwise |
| `const { x } = props`  | ✅      | Auto-converted to useProp getter         |
| `obj.a.b.c`            | ✅      | Fine-grained tracking                    |
| `obj[dynamicKey]`      | ⚠️      | Coarse tracking (whole object)           |
| `compute(count)`       | ✅      | Expanded at call site                    |
| `() => count`          | ✅      | Reads latest via getter                  |
| `arr.map(x => <Li />)` | ✅      | Auto keyed list                          |
| `if (count > 0) {}`    | ✅      | Native control flow                      |
| `$state` in loop       | ❌      | Compile error                            |
| `$effect` in nested fn | ❌      | Compile error                            |

---

## FAQ

### Q: Why isn't my variable updating?

Check if it flows to a reactive sink (JSX, `$effect`). Variables only used in plain JS become snapshots.

```js
// This won't update — snapshot
let count = $state(0)
const x = count
setInterval(() => console.log(x), 1000) // always logs initial value

// This updates — flows to effect
$effect(() => console.log(count)) // logs on every change
```

### Q: Will my event handler recreate on every render?

No. Fict transforms reactive reads inside handlers to getter calls. The handler function itself is defined once and remains stable.

### Q: How do I opt out of tracking?

Use `untrack()`:

```js
$effect(() => {
  const value = untrack(() => count) // reads count without tracking
  console.log(value)
})
```

### Q: What about `obj[key]` performance?

Dynamic property access tracks the whole object. If this causes too many updates, consider:

1. Using static property access where possible
2. Restructuring data to avoid dynamic keys in hot paths

### Q: Can I use async/await in effects?

Yes, but be aware that only synchronous reads in the first tick establish dependencies:

```js
$effect(async () => {
  console.log(count)  // tracked
  await fetch(...)
  console.log(other)  // NOT tracked (after await)
})
```

---

## See Also

- [compiler-spec.md](./compiler-spec.md) — Detailed compiler transformation rules
- [diagnostic-codes.md](./diagnostic-codes.md) — Warning and error code reference
- [architecture.md](./architecture.md) — Runtime and compiler architecture
