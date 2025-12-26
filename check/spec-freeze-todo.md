# Spec Freeze TODO (v1.x)

Purpose: lock down `$state` / `$effect` / derived semantics and bring compiler+runtime tests to spec-grade completeness. Track decisions, code changes, and tests needed before calling 1.x semantics frozen.

## Decisions to Lock in the Spec

- [x] Clarify placement rules: `$state` and `$effect` allowed only at component/module top level; loops/conditionals rejected. Nested functions remain disallowed for `$state`/`$effect` unless explicitly marked (current transformer errors).
- [x] Clarify destructuring `$state`: **hard error**. Spec updated to reflect the transformer behavior.
- [x] Alias semantics: `const y = x` becomes a reactive getter in components; snapshots require explicit escape (e.g. `untrack`). Documented in spec.
- [x] Derived under control flow: dependency graph + region grouping defined in spec; Rule D tests exercise early-return/ternary coverage.
- [x] Event/closure capture: handlers read latest values; snapshot must be manual. Documented in spec with tests.
- [x] Illegal patterns: assignment to `$state()` return, `$effect` in disallowed scopes, `$state` in loops/conditionals, invalid `$state` destructuring are compile errors.
- [x] Cross-module semantics: exported derived are memoized; imports read memo getters; event-only usage still memoized.
- [x] Warning semantics: deep mutation (`FICT-M`), dynamic property access/black-box (`FICT-H`) are the authoritative codes/messages.
- [ ] Update `compiler-spec.md` title tag to “Formal Semantics v1.x” after final review.

## Compiler Implementation Tasks

- [x] Enforce placement rules in transformer per final decision (reject `$effect` in control flow; align nested `$state` behavior).
- [x] Align destructuring handling with chosen semantics (hard error) and ensure messages match spec.
- [x] Ensure alias/snapshot rewriting matches spec (live getter for aliases; explicit snapshot escape supported).
- [x] Region grouping handles conditional branches + early returns deterministically; documented in Rule D.
- [x] Normalize error codes/messages for illegal patterns and warnings (`FICT-H`/`FICT-M`).
- [x] Keep cross-module export/import behavior consistent (exported derived as memo getter; event usage reads current memo).

## Compiler Test Coverage

- [x] Per-rule cases mirror finalized spec text (`spec-rules.test.ts`, `spec-complete.test.ts`).
- [x] `$effect` placement errors (loops/conditionals/nested) covered in `semantic-validation.test.ts`.
- [x] Destructuring hard-error coverage in `base-transform.test.ts`.
- [x] Control-flow/early-return region grouping asserted in `rule-d-verify.test.ts`.
- [x] Event/closure capture live-read behavior covered in `spec-rules.test.ts` and `transform.test.ts`.
- [x] Illegal-pattern tests: assignment to `$state()`, loop/conditional placement, `$effect` scope.
- [x] Cross-module tests: default/named/re-export + event-only usage in `cross-module.test.ts`.
- [x] Spec↔test matrix added (`docs/spec-test-matrix.md`).

## Runtime Test Coverage

- [x] End-to-end JSX→DOM cases (Counter/Todo etc.) mapped via `complete-integration.test.ts`.
- [x] Keyed list lifecycle/identity coverage (`keyed-list-e2e.test.ts`, `nested-keyed-list-e2e.test.ts`).
- [x] Memory/leak + lifecycle stress (`memory-lifecycle.test.ts`, `list-fuzzing.test.ts`).
- [x] Effect scheduling/cleanup ordering (`scheduler.test.ts`, `effect`-focused cases).

## Traceability & Docs

- [x] Update `docs/compiler-spec.md` / `docs/architecture.md` with final semantics and link to the spec↔test matrix.
- [ ] Tag the doc with a version/date once the final audit is done; changes after that are “bug/perf only”.
