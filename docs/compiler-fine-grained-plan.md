# Fine-grained Compiler & Runtime Plan

**Document owner:** runtime/compiler working group  
**Last updated:** 2025-12-04T18:58:53.970Z

## 1. Goals

- Eliminate rerender-driven DOM updates inside keyed blocks; every dynamic binding should update existing nodes in place.
- Compile JSX templates into stable node graphs with explicit references, so the runtime only performs atomic ops (insert/move/destroy).
- Retain current signal semantics (same-reference writes are ignored) while guaranteeing UI updates via compiler-generated mechanisms.

## 2. Scope assumptions

- JSX coverage v1: intrinsic elements, Fragment, conditional (`?:`, logical &&) and array `.map` usage.
- Out of scope for v1: slots/portals beyond existing helpers, suspense/resource coordination, compiler plugins for non-TS targets.
- Runtime may gain new private helpers but public API (`createSignal`, `createEffect`, etc.) must remain backward-compatible.

## 3. Architecture overview

1. **Template decomposition**
   - Parse JSX tree, classify each node as static/dynamic.
   - Allocate deterministic DOM references: `const el0 = ...`, `const txt0 = ...`, `const marker0 = ...`.
   - Generate binding code: `bindText`, `bindAttribute`, `bindClass`, `bindStyle`, `insertChild`, `createKeyedListBlock` with explicit signals.
2. **Fine-grained signals per site**
   - For every dynamic expression, emit a `createMemo`/`createEffect` that writes directly to the DOM reference.
   - Event handlers bound exactly once; updates only change functions when dependencies truly differ (compiler knows if handler captures state).
3. **Stable structures & patch tables**
   - Compiler emits a "patch table" describing each node's dynamic slots (text, attr, child). Runtime helpers simply iterate and apply updates.
   - Fragment/array outputs are flattened at compile time; runtime never concatenates arbitrary arrays.
4. **Keyed list specialization**
   - Instead of calling generic `createList`, compiler emits a bespoke updater:
     ```ts
     const blocks = new Map()
     function updateList(nextItems) {
       // 1. compute diffs keyed by `getKey`
       // 2. for reused blocks: update valueSig/indexSig, increment version counter
       // 3. move markers using runtime.moveBlock(start, end, anchor)
       // 4. destroy blocks explicitly
     }
     ```
   - Each block stores references to its DOM nodes and per-field bindings; rerender is never invoked.
5. **Version counter shim**
   - For contexts where same-reference writes must notify (e.g., keyed items), compiler wraps values as `{ value, ver }` and increments `ver` on assignment.
   - Runtime proxies expose `proxy.value` transparently so user code still interacts with raw value.

## 4. Runtime helper adjustments

| Helper                              | Status              | Notes                                                                |
| ----------------------------------- | ------------------- | -------------------------------------------------------------------- |
| `bindText(node, getter)`            | new                 | sets up effect writing to `node.data`.                               |
| `bindAttribute(node, name, getter)` | new                 | handles bool/class/style special cases.                              |
| `insertChild(anchor, getter)`       | existing (`insert`) | may need overload to accept markers.                                 |
| `createKeyedListBlock(config)`      | new                 | low-level block manager invoked by compiler-generated updater.       |
| `moveBlock(block, anchor)`          | new                 | relocates start/end markers + nodes without touching inner bindings. |
| `destroyBlock(block)`               | refined             | ensures root cleanup + node removal.                                 |

Runtime keeps ManagedBlock for legacy paths, but compiler-generated code bypasses rerender.

## 5. Implementation phases

### Phase 0 – Design sign-off

- [ ] Freeze JSX subset + runtime helper API.
- [ ] Author reference examples for compiler output (counter, nested lists, fragments).

### Phase 1 – Helper groundwork

- [ ] Implement `bindText`, `bindAttribute`, `bindClass`, `bindStyle` with effect-based updates.
- [ ] Implement block movement helpers (`moveBlock`, `destroyBlock`) independent of rerender.
- [ ] Add lightweight version-counter utility (`createVersionedSignal`).

### Phase 2 – Compiler codegen overhaul (TS plugin)

- [ ] Extend compiler pipeline to emit DOM creation + binding calls per template.
- [ ] Generate deterministic variable names/indices for nodes and markers.
- [ ] Output list updaters with explicit key diff logic and version counter usage.
- [ ] Ensure conditional outputs map to "truthy branch" / "fallback branch" functions that only mount once.

### Phase 3 – Runtime integration & opt-in flag

- [ ] Add feature flag to switch between legacy rerender path and new fine-grained path.
- [ ] Update tests to cover both modes (especially nested keyed lists, conditional toggles, primitive updates).
- [ ] Document migration guidance.

### Phase 4 – Rollout & cleanup

- [ ] Default flag to new compiler output after internal verification.
- [ ] Deprecate rerender-specific code (ManagedBranch, rerenderBlock fast paths) once no longer needed.
- [ ] Update docs (architecture, contributing) to describe new compilation model.

## 6. Risks & mitigations

- **Compiler complexity spike** → Mitigate by scaffolding high-level IR (e.g., template graph) before emitting JS, and keep exhaustive tests.
- **Runtime regression** → Keep legacy path guarded by flag until benchmarks + apps verify parity.
- **Debuggability** → Provide source maps / dev tooling to map generated node refs back to JSX elements.

## 7. TODO checklist

- [ ] Approve spec & subset with stakeholders.
- [ ] Prototype helper bindings on a single component (hand-written) to validate runtime API.
- [ ] Implement Phase 1 helpers + tests.
- [ ] Draft IR for compiler codegen, including node/anchor allocation strategy.
- [ ] Implement list updater generator with version counters.
- [ ] Integrate flag + end-to-end tests (counter, keyed list, nested conditionals).
- [ ] Update docs (architecture + new plan) once feature is stable.
