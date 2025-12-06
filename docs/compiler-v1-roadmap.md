# Compiler v1.0 Roadmap

_Last updated: 2025-12-06_

This document captures the remaining compiler-ts work required to confidently ship Fict v1.0. Items are ordered by priority; each section lists the motivation, concrete tasks, and acceptance criteria. Use the checklist to track progress.

## Priority P0 — Must Land Before v1.0

- [ ] **Fine-grained DOM codegen completeness**
  - _Why_: Current lowering skips several JSX forms (fragments, nested conditionals, portals), forcing fallbacks to legacy paths.
  - _What to do_: Extend the transformer to cover the full JSX subset defined in `compiler-spec.md`, emitting stable node references plus per-slot bindings. Ensure keyed lists, fragments, and conditional blocks all share the same lowering IR.
  - _How to validate_: Add snapshot-oriented compiler tests per construct and integration tests exercising the generated helpers end-to-end.

- [ ] **Event prop handling under fine-grained mode**
  - _Why_: Today on\* props are treated like generic attributes, so listeners never attach when `fineGrainedDom` is true.
  - _What to do_: Detect event props during lowering, emit explicit `bindEvent` helpers (or inline `addEventListener`) with cleanup hooks, and cover bubbling/capture modifiers if applicable.
  - _How to validate_: Integration test that a button compiled via fine-grained mode reacts to clicks and removes the handler on unmount.

- [ ] **Spec-aligned semantic validation**
  - _Why_: The 1.0 spec forbids `$state` / `$effect` inside loops/conditionals unless wrapped in `stable`, but the compiler does not error.
  - _What to do_: Implement AST walkers enforcing each rule, surface actionable diagnostics, and document them in `compiler-spec.md`.
  - _How to validate_: Add negative tests per rule and ensure the new "Formal Semantics" appendix stays in sync.

## Priority P1 — Should Land Shortly After P0

- [ ] **Alias-safe reactive lowering**
  - _Why_: Reactive identifiers imported/exported across modules can currently desugar into duplicated signals.
  - _What to do_: Introduce an ownership map in the transformer so aliases reference the same slot, and emit hoisted declarations once.
  - _How to validate_: Multi-module compiler tests showing shared state updates exactly once.

- [ ] **Comprehensive feature coverage in fine-grained integration tests**
  - _Why_: CI currently runs almost all suites with `fineGrainedDom: false`.
  - _What to do_: Enable true-mode variants for lists, portals, conditional visibility, and props-updates; wire them into `pnpm test`.
  - _How to validate_: New tests fail if the fine-grained helpers regress.

- [ ] **Fragment & nested list lowering**
  - _Why_: Nested structures still emit placeholder comment sentinels and force rerender paths.
  - _What to do_: Extend the IR to represent fragment anchors and produce deterministic child ordering without runtime diffing.
  - _How to validate_: Golden compiler tests plus DOM-level assertions that nested keyed lists preserve nodes.

## Priority P2 — Nice-to-have Before GA

- [ ] **Performance & memory benchmarks**
  - _Why_: Need empirical validation against the 1.0 budgets.
  - _What to do_: Add benchmark projects (worst-case lists, deeply nested components) and automate via `pnpm bench`.
  - _How to validate_: Record baseline numbers and track regressions in CI.

- [ ] **Developer ergonomics / diagnostics**
  - _Why_: Fine-grained lowering introduces new failure modes.
  - _What to do_: Improve error messages (show snippet, hint at fix), add compiler-time hints when falling back to legacy paths, and expose a flag to dump the lowered IR for inspection.
  - _How to validate_: Unit tests on diagnostic formatting and a doc example.

## Cross-cutting To-do List

- [ ] Align `compiler-spec.md` with any new lowering constructs (event helpers, fragment IR, aliasing rules).
- [ ] Update `docs/fine-grained-jsx-subset.md` or consolidate it if superseded by this roadmap.
- [ ] Ensure runtime helpers needed by the new lowering exist and are tree-shakeable.
- [ ] Mirror changes in `compiler-swc` once the TypeScript pipeline stabilizes.

Keep this document updated as milestones land; unchecked items block the v1.0 readiness review.
