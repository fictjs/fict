# Compiler v1.0 Roadmap

_Last updated: 2025-12-06_

This document captures the remaining compiler-ts work required to confidently ship Fict v1.0. Items are ordered by priority; each section lists the motivation, concrete tasks, and acceptance criteria. Use the checklist to track progress.

## Priority P0 — Must Land Before v1.0

- [ ] **Diagnostic polish & traceability**
  - _Why_: Error/warning codes (`FICT-*`) exist, but messages and anchors need a final pass before freeze.
  - _What to do_: Audit wording, align with `compiler-spec.md`, and assert codes/messages in tests. Keep the spec↔test matrix current.
  - _How to validate_: Negative cases cover each diagnostic anchor; matrix links stay green.

- [ ] **SWC / TS plugin parity**
  - _Why_: The TS/Babel pipeline leads; SWC needs ref/property binding, ref cleanup, keyed block helpers, and "use no memo" parity.
  - _What to do_: Port recent lowering changes to the SWC adapter and share fixtures.
  - _How to validate_: Shared fixtures pass under both pipelines with approved diffs only.

- [ ] **Spec versioning**
  - _Why_: We need a dated “v1.x semantics frozen” tag to unblock downstream integrations.
  - _What to do_: Stamp the spec with version/date, add a changelog note, and define the bug/perf-only policy post-freeze.
  - _How to validate_: Docs updated; CI references the frozen tag; release notes enumerate the frozen behaviors.

## Priority P1 — Should Land Shortly After P0

- [ ] **Perf/coverage expansion**
  - _Why_: Need post-freeze perf baselines and fuzzing around keyed block helpers.
  - _What to do_: Broaden `list-fuzzing` scenarios, add microbenchmarks for keyed block moves, and record baselines.
  - _How to validate_: Bench targets checked into CI; regressions flagged automatically.

- [ ] **DX tooling**
  - _Why_: Developers need visibility into lowered output and fallbacks.
  - _What to do_: Add a compiler flag to emit lowered IR for inspection and surface fallback-to-legacy notices as warnings.
  - _How to validate_: Snapshot tests for the flag output; warning formatting tests.

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
