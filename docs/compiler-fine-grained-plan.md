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

- [x] Freeze JSX subset + runtime helper API. _(See `docs/fine-grained-jsx-subset.md`.)_
- [x] Author reference examples for compiler output (counter, nested lists, fragments).

### Phase 1 – Helper groundwork

- [x] Implement `bindText`, `bindAttribute`, `bindClass`, `bindStyle` with effect-based updates.
- [x] Implement block movement helpers (`moveBlock`, `destroyBlock`) independent of rerender.
- [x] Add lightweight version-counter utility (`createVersionedSignal`).

### Phase 2 – Compiler codegen overhaul (TS plugin)

- [x] Extend compiler pipeline to emit DOM creation + binding calls per template. _(Compiler TS transformer now has an opt-in `fineGrainedDom` flag that lowers simple intrinsic JSX to `document.createElement` + `bind_`helpers; see`packages/compiler-ts/src/**tests**/transform.test.ts`.)\*
- [x] Generate deterministic variable names/indices for nodes and markers. _(Fine-grained lowering now assigns stable `__fg{n}_el{m}` / `__fg{n}_txt{m}` identifiers per template via a compiler-level counter, easing debugging and predictable diffs.)_
- [x] Output list updaters with explicit key diff logic and version counter usage. _(Compiler now lowers keyed `map` calls (when JSX + `key`) into fine-grained renderers that operate on versioned `itemSig`/`indexSig` signals, emitting DOM creation + `bind_` calls instead of rerendering strings.)\*
- [x] Ensure conditional outputs map to "truthy branch" / "fallback branch" functions that only mount once. _(Conditional lowering now detects JSX branches and routes them through the fine-grained template builder so both true/false branches emit stable DOM graphs with `bind_` hooks instead of runtime rerendering.)\*

### Phase 3 – Runtime integration & testing

- [x] Add feature flag to switch between legacy rerender path and new fine-grained path. _(Feature flag infrastructure was implemented and later removed on 2025-12-05 after validation.)_
- [x] Update tests to cover fine-grained implementation (nested keyed lists, conditional toggles, primitive updates). _(Comprehensive test suite validates fine-grained rendering across all scenarios.)_
- [x] Document migration guidance. _(Migration documentation was provided and later archived after legacy mode removal.)_

### Phase 4 – Rollout & cleanup

- [x] Default flag to new compiler output after internal verification. _(Fine-grained rendering became the default and only mode.)_
- [x] Deprecate rerender-specific code (ManagedBranch, rerenderBlock fast paths) once no longer needed. _(Removed feature flag infrastructure and legacy keyed list adapter on 2025-12-05. Core block management functions retained as they implement the fine-grained mechanism.)_
- [x] Update docs (architecture, README, contributing) to describe the new compilation model. _(Updated all documentation to reflect fine-grained as the only rendering mode on 2025-12-05.)_

## 6. Risks & mitigations

- **Compiler complexity spike** → Mitigate by scaffolding high-level IR (e.g., template graph) before emitting JS, and keep exhaustive tests.
- **Runtime regression** → Keep legacy path guarded by flag until benchmarks + apps verify parity.
- **Debuggability** → Provide source maps / dev tooling to map generated node refs back to JSX elements.

## 7. TODO checklist

- [x] Approve spec & subset with stakeholders. _(Documented in `docs/fine-grained-jsx-subset.md`.)_
- [x] Prototype helper bindings on a single component (hand-written) to validate runtime API. _(See `src/__tests__/fine-grained-prototype.test.ts`.)_
- [x] Implement Phase 1 helpers + tests.
- [x] Draft IR for compiler codegen, including node/anchor allocation strategy. _(See `docs/fine-grained-ir.md`.)_
- [x] Implement list updater generator with version counters. _(`createKeyedBlock` now wraps items in `createVersionedSignal`, see `list-helpers.ts` and accompanying tests.)_
- [x] Integrate flag + end-to-end tests (counter, keyed list, nested conditionals). _(End-to-end tests validated fine-grained rendering; flag infrastructure was later removed on 2025-12-05.)_
- [x] Update docs (architecture + new plan) once feature is stable. _(Documentation updated to reflect fine-grained as the only rendering mode on 2025-12-05.)_
