# Spec Freeze TODO (v1.x)

Purpose: lock down `$state` / `$effect` / derived semantics and bring compiler+runtime tests to spec-grade completeness. Track decisions, code changes, and tests needed before calling 1.x semantics frozen.

## Decisions to Lock in the Spec

- [ ] Clarify placement rules: `$state` and `$effect` allowed only at component/module top level; explicitly forbid conditionals/loops and decide whether nested functions are allowed (spec currently says illegal; transformer/tests allow).
- [ ] Clarify destructuring `$state`: snapshot vs hard error. Current transformer throws; spec says snapshot. Pick one and document.
- [ ] Alias semantics: `const y = x` → reactive getter in components vs snapshot escape; document the explicit snapshot pattern (e.g. `untrack`).
- [ ] Derived under control flow: define dependency graph for `if`/`switch`/early-return/ternary and how region grouping works; include how partial branches are represented.
- [ ] Event/closure capture: define that event handlers read latest values; document how to intentionally snapshot.
- [ ] Illegal patterns: direct assignment to `$state(...)` return, `$effect` in disallowed scopes, `$state` in loops/conditionals, invalid `$state` destructuring; define all as compile errors.
- [ ] Cross-module semantics: exported derived always memo, getter shape for imports, module-level event-only usage still memo.
- [ ] Warning semantics: deep mutation (Rule M), dynamic property access/black-box (Rule H); make messages and codes authoritative.
- [ ] Update `compiler-spec.md` to “Formal Semantics v1.x” (remove “Draft”) once above are resolved and reflected in `docs/architecture.md`.

## Compiler Implementation Tasks

- [ ] Enforce placement rules in transformer per final decision (reject `$effect` in control flow; align nested `$state` behavior).
- [ ] Align destructuring handling with chosen semantics (either allow snapshot with warning or hard error) and ensure messages match spec.
- [ ] Ensure alias/snapshot rewriting matches spec (live getter for aliases in run-once components; explicit snapshot escape supported).
- [ ] Make region grouping handle conditional branches + early returns deterministically; document and test the IR it emits.
- [ ] Normalize error codes/messages for illegal patterns and warnings (Rule H/M).
- [ ] Keep cross-module export/import behavior consistent (exported derived as memo getter; event usage reads current memo).

## Compiler Test Coverage

- [ ] Add per-rule cases that mirror the finalized spec text (one test per bullet above). Link each test to a spec section.
- [ ] Add `$effect` placement errors (loops/conditionals/nested) coverage.
- [ ] Add destructuring coverage for the chosen semantics (snapshot vs error) including nested/alias patterns.
- [ ] Add control-flow/early-return derived graph tests that assert region grouping output shape.
- [ ] Add event/closure capture tests showing live value vs intentional snapshot.
- [ ] Add illegal-pattern tests: assignment to `$state()` return, `$state` in loop/conditional, `$effect` in disallowed scopes.
- [ ] Add cross-module tests covering default export, named export, re-export, and event-only consumption of exported derived.
- [ ] Maintain a spec↔test matrix (section → test name) in the spec or a companion doc.

## Runtime Test Coverage

- [ ] Add/verify end-to-end JSX→DOM cases for Counter/Todo/etc. mapped to architecture dependency-graph behaviors (some exist; map explicitly).
- [ ] Add cross-module integration (imported memo/state in runtime wiring) if missing.
- [ ] Extend memory/leak tests with repeated mount/unmount of keyed lists and conditional branches (stress cycles).
- [ ] Consider additional property-based/fuzz around list diff + effect ordering (augment existing `list-fuzzing` if needed).
- [ ] Verify effect scheduling/cleanup ordering against spec diagrams; add focused tests if any gaps remain.

## Traceability & Docs

- [ ] Update `docs/compiler-spec.md` and `docs/architecture.md` with final semantics and link to the spec↔test matrix.
- [ ] When semantics freeze, tag the doc with a version/date and note that changes after that are “bug/perf only”.
