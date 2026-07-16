# React Compiler and Beyond: Capability Boundaries of Compiler-Driven UI Frameworks

> Bottom line first: React Compiler is a major step forward, but it optimizes React's expression and render costs within React's runtime contract.  
> Compiler-first fine-grained frameworks like Fict pursue a different objective: move more update routing to compile time, then execute updates through dependency propagation at runtime.  
> This is not a winner-takes-all debate. It is an engineering trade-off across different objective functions.

Fict Repo: https://github.com/fictjs/fict

---

## 0. Scope and Rigor

To avoid slogan-level comparisons, this article uses strict boundaries:

1. It compares two technical routes:
   - `React + React Compiler` (preserving React semantics)
   - `Compiler-first fine-grained` (using Fict as the concrete example)
2. It separates three layers:
   - Developer experience (mental overhead and ergonomics)
   - Performance model (update path and cost structure)
   - Semantic constraints (effects, lifecycle, error handling, consistency)
3. Claims about Fict are grounded in this repository's implementation and docs, not idealized marketing descriptions.

---

## 1. What React Compiler Actually Solves

React Compiler does not "replace React." It improves React's default performance posture by:

1. Inferring dependency boundaries so developers write less manual `useMemo` and `useCallback`.
2. Reusing expressions and JSX subtrees more aggressively.
3. Raising performance floor while preserving the React programming model.

A conceptual sketch:

```tsx
function ProductList({ products, filter, onSelect }) {
  const cache = getCompilerCache()

  const filtered = cache.memo('filtered', [products, filter], () =>
    products.filter(p => p.category === filter),
  )

  const handleClick = cache.memo('handleClick', [onSelect], () => id => onSelect(id))

  return cache.memo('listJSX', [filtered, handleClick], () => (
    <ul>
      {filtered.map(p => (
        <ProductItem key={p.id} product={p} onClick={handleClick} />
      ))}
    </ul>
  ))
}
```

Key point: this is stronger automatic memoization inside React semantics, not a replacement of Fiber/Hook contracts.

---

## 2. What React Compiler Does Not Redefine

A precise statement:

1. React Compiler can remove substantial redundant compute and subtree work.
2. It does not redefine React into a signal-driven DOM execution engine.

Why:

1. React's core abstraction is still component-tree scheduling and commit semantics.
2. Compiler optimizations must remain inside React boundaries: hook ordering, effect timing, concurrent scheduling, error boundary behavior.
3. Therefore it optimizes "how much work React does," not "what React fundamentally is."

Practical implications:

1. React updates are not always full-tree reruns due to bailouts and memoized outputs.
2. But the dominant scheduling unit remains component/subtree semantics, not explicit signal graph nodes.
3. `React.memo` with `children` is not inherently useless:
   - It often fails if children are recreated each render.
   - It can work when references are stabilized by caller patterns or compiler transforms.

---

## 3. What Fict Changes (Based on Current Repository)

Fict's route is compiler-first fine-grained reactivity: compile dependency relationships, then propagate updates through runtime graph nodes.

This is visible in the current codebase:

1. Macro contract:
   - `$state` and `$effect` are compile-time macros and throw if executed at runtime (`packages/fict/src/index.ts`).
2. Compile-time placement constraints:
   - Macro placement is validated; loops/conditionals/nested contexts are restricted according to compiler rules (`packages/compiler/src/index.ts`, `docs/compiler-spec.md`).
3. IR and lowering pipeline:
   - HIR, reactivity, optimization, and emission stages live in the Rust crates
     under `crates/fict-hir`, `crates/fict-reactivity`, and `crates/fict-emit`.
4. Runtime graph model:
   - Signal/computed/effect propagation is implemented in `packages/runtime/src/signal.ts`.
5. Local list reconciliation still exists:
   - Fict avoids whole-tree VDOM diffing, but keyed local reconciliation is implemented (`packages/runtime/src/reconcile.ts`, `packages/runtime/src/list-helpers.ts`).
6. Fail-closed guarantee mode is explicit:
   - `FICT_STRICT_GUARANTEE=1` enforces strict diagnostics in CI (`docs/reactivity-guarantee-matrix.md`).

This corrects two frequent misconceptions:

1. "Fict has no reconciliation at all."  
   Not true. It avoids whole-tree VDOM diffing; it still reconciles local keyed list paths.
2. "Fict is only syntax sugar over existing runtimes."  
   Not true. It has a dedicated compile-time dataflow and lowering pipeline with a distinct runtime execution model.

---

## 4. Cost Model: Same Interaction, Different Work Units

Use a searchable list as an example:

```tsx
// React + Compiler (conceptual)
function SearchList({ items }) {
  const [query, setQuery] = useState('')
  const [sortBy, setSortBy] = useState('name')

  const filtered = items.filter(item => item.name.toLowerCase().includes(query.toLowerCase()))
  const sorted = [...filtered].sort((a, b) => a[sortBy].localeCompare(b[sortBy]))

  return (
    <div>
      <input value={query} onChange={e => setQuery(e.target.value)} />
      <select value={sortBy} onChange={e => setSortBy(e.target.value)}>
        <option value="name">Name</option>
        <option value="date">Date</option>
      </select>
      <p>{sorted.length} results</p>
      <ul>
        {sorted.map(item => (
          <li key={item.id}>{item.name}</li>
        ))}
      </ul>
    </div>
  )
}
```

```tsx
// Fict (conceptual)
function SearchList({ items }) {
  let query = $state('')
  let sortBy = $state('name')

  const filtered = items.filter(item => item.name.toLowerCase().includes(query.toLowerCase()))
  const sorted = [...filtered].sort((a, b) => a[sortBy].localeCompare(b[sortBy]))

  return (
    <div>
      <input value={query} onInput={e => (query = e.target.value)} />
      <select value={sortBy} onChange={e => (sortBy = e.target.value)}>
        <option value="name">Name</option>
        <option value="date">Date</option>
      </select>
      <p>{sorted.length} results</p>
      <ul>
        {sorted.map(item => (
          <li key={item.id}>{item.name}</li>
        ))}
      </ul>
    </div>
  )
}
```

Conceptual complexity comparison:

1. React path:
   - `O(rendered-subtree + diff-subtree + patch)`, reduced by compiler/bailouts.
2. Fict path:
   - `O(changed-sources + affected-computed/effects + affected-bindings + local-list-reconcile)`.

The correct conclusion is not "always faster/slower":

1. Fine-grained tends to win when changes are local, dependency graph is sparse, and list size is large.
2. React Compiler is often sufficient when bottlenecks are I/O dominated or UI compute is moderate.

---

## 5. Semantic Trade-offs (The Part People Skip)

Performance-only comparisons are incomplete. Semantic behavior determines production risk.

### 5.1 Effects Are Not Mechanical One-to-One Replacements

`useEffect` and `$effect` are not drop-in equivalents:

1. Fict `$effect` is compiler-constrained and analyzed in a macro-based model.
2. Dependency collection semantics differ from React dependency-array workflows.
3. Less manual dependency bookkeeping reduces a class of developer mistakes, but correctness partially shifts toward compiler analyzability and guarantee coverage.

### 5.2 Control Flow and Dynamic Shapes Need Explicit Validation

High-risk migration areas:

1. Effect cleanup timing under control-flow branch switching.
2. Closure reads in event chains and async callbacks.
3. Cancellation/race handling in async flows.
4. List identity behavior under unstable key quality.

### 5.3 "No Free Ecosystem Inheritance"

React's long-lived advantages are structural:

1. Ecosystem breadth and battle-tested framework integrations.
2. Mature concurrent scheduling and tooling culture.
3. Broad operational knowledge in teams.

Compiler-first routes must independently harden:

1. DevTools observability
2. SSR/Hydration/Resume stability
3. Error boundary and suspense consistency
4. Third-party integration contracts

---

## 6. Side-by-Side Decision Matrix

| Dimension            | React + Compiler                                       | Fict / Compiler-First Fine-Grained                            |
| -------------------- | ------------------------------------------------------ | ------------------------------------------------------------- |
| Primary objective    | Reduce React performance tuning overhead               | Lower runtime update upper bound                              |
| Core mechanism       | Automatic memoization + bailouts                       | Compile-time dependency graph + runtime propagation           |
| Dominant update unit | Component/subtree scheduling                           | Source/computed/binding-level propagation                     |
| List behavior        | Reconciliation in React tree semantics                 | Local keyed reconciliation                                    |
| Migration cost       | Low to medium (keep React mental model)                | Medium to high (compiler constraints + semantic verification) |
| Main risk            | Performance predictability tied to component structure | Semantic edge cases and compiler coverage boundaries          |

Important framing: this is objective-function selection, not a "modernity contest."

---

## 7. What a Defensible Technical Article Must Include

If the goal is engineering evidence rather than opinion, include at least:

1. Public benchmark method:
   - Dataset, warm/cold separation, hardware/software baselines.
2. Metric decomposition:
   - Render/commit timing, DOM mutations, GC, memory peak.
3. Counterexample sets:
   - Cases where React is better; cases where fine-grained is better.
4. Semantic equivalence tests:
   - Cleanup, error boundaries, async races, fallback paths.
5. Migration cost quantification:
   - Changed LOC, defect categories, regression count, fix lead time.

Without this, conclusions remain high-quality perspective, not reproducible engineering claims.

---

## 8. Reproducible Evaluation Appendix

Use repository-native commands only.

1. Environment baseline:
   - Node `>=20`
   - pnpm `>=9`
   - OS/CPU/RAM
   - Browser version (for benchmark runs)
2. Repository health:

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm lint
```

3. Strict guarantee gate:

```bash
FICT_STRICT_GUARANTEE=1 pnpm build
```

4. Framework benchmark flow:

```bash
pnpm perf:data
pnpm perf:results
```

5. Runtime stress:

```bash
pnpm stress:runtime
pnpm stress:runtime:long
```

6. Compiler architecture and release guard:

```bash
pnpm guardrails:rust-crates
pnpm release:compiler:verify
```

7. Reporting minimums:
   - Scenario and data scale (`N`, update rate, list size)
   - Median + IQR from at least 5 runs
   - Error logs and failure sample links

---

## 9. Migration Readiness Checklist

Before adopting a compiler-first route, verify:

1. You are solving a front-end CPU update bottleneck, not primarily network/back-end latency.
2. You can run strict guarantee mode in CI (`FICT_STRICT_GUARANTEE=1`).
3. You have semantic regression coverage for effects, async races, and error boundaries.
4. Team conventions can absorb macro constraints and compile-time diagnostics.
5. You have a rollback strategy for fallback-path regressions.

When to prefer React + Compiler first:

1. Large existing React codebase with narrow migration window.
2. Heavy dependency on mainstream React ecosystem/runtime assumptions.
3. Performance gains needed are incremental, not architectural.

When Fict-like route is justified:

1. CPU update path is a top product bottleneck.
2. Large/interactive local updates dominate user experience.
3. Team is willing to trade some migration complexity for lower runtime update ceiling.

---

## 10. Final Conclusion

React Compiler matters because it turns performance tuning expertise into compiler defaults inside React semantics.

Fict-like compiler-first systems matter because they can replace rerun-and-compare execution with dependency-driven propagation for many update paths.

Both are valid. They optimize different costs:

1. React Compiler answers:
   - How far can we push automatic performance within React's existing contract?
2. Compiler-first fine-grained answers:
   - If dataflow is known at compile time, how much runtime tree-level comparison can we avoid?

A serious engineering decision should not declare a universal winner.  
It should define boundaries, publish evidence, and make trade-offs explicit.
