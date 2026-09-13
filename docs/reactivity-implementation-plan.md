# Reactivity implementation and qualification

This checklist tracks the implementation requested after the 0.35.0 architecture
review of `af3d5fc0`. Each independent item receives its own commit, implementation
evidence, and applicable validation. A checked item must describe working behavior,
not only an analysis pass, an API sketch, or a passing unrelated test suite.

| Item | Required result                                                                                                                                                       | Completion evidence                                                                                                                                                                           | Status   |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| S1   | Explicit snapshot semantics and diagnostic fixes agree under default strict compilation. Retained reactive closures and unsafe lifetime escapes remain diagnosed.     | Executable cookbook examples, adversarial native compiler tests, disabled/safe/full behavioral checks.                                                                                        | Complete |
| S2   | Official selector and reactive callback APIs are recognized by binding identity and their actual tracking/lifetime contracts.                                         | Positive imports/aliases and negative shadowed, external, deferred, and reassigned-host cases.                                                                                                | Pending  |
| S3   | Collection, fresh-copy, and per-row signal analysis supports the optimized keyed fixture with strict guarantees.                                                      | Strict fixture compilation, precise alias/mutation regressions, same-key replacement and teardown behavior.                                                                                   | Pending  |
| S4   | Custom compiler host environment and metadata obligations are executable and documented.                                                                              | Facade/native integration contract tests, missing metadata cases, consumer package checks.                                                                                                    | Pending  |
| S5   | Representative application coverage measures strict boundary incidence and usable diagnostic repairs.                                                                 | Maintained corpus with source identity, diagnostics, boundary/LOC counts, migration evidence, strict production and browser gates; distinguish maintained fixtures from independent adoption. | Pending  |
| G1   | Safe implicit memos with one logical JSX consumer can be removed without erasing observable computation or ownership semantics.                                       | Native output and browser/SSR behavior across safe/full/disabled options, explicit memo, multi-consumer, coercion, errors, and cleanup controls.                                              | Pending  |
| G2   | Reactive allocation and optimization decisions are traceable from source consumers through EmitIR to generated bindings and owners.                                   | Verified graph/decision information and final-output counters, including reasons for materialization, inlining, retention, and rejected fusion.                                               | Pending  |
| G3   | Existing SSA simplification facts and lazy placement opportunities are either safely realized in emitted code or accurately reported as retained work.                | Semantic differential tests and final generated-code evidence; no claims based solely on unused analysis fields.                                                                              | Pending  |
| G4   | Creation, replacement, and append costs are profiled and reduced where measurements support safe changes.                                                             | Controlled allocation/CPU profiles, complete repeated benchmark batches, memory and disposal checks, documented rejected experiments.                                                         | Pending  |
| G5   | README performance claims correspond to the qualified strict build and identify versions, artifact hashes, normalization, uncertainty, and the unrounded 1.10 target. | Frozen source/build provenance, complete keyed/browser checks, reproducible archive and README data validation.                                                                               | Pending  |
| A1   | An async graph contract specifies readiness, stale/current values, invalidation, errors, effect commit, ownership, and compatibility.                                 | Implementable state transitions and executable acceptance scenarios, not percentage scores.                                                                                                   | Pending  |
| A2   | An explicit async computation is a reactive graph node, including Promise and async iterable completion, invalidation, and cancellation.                              | Graph-level dependency/status behavior, stale-flight rejection, cancellation and disposal tests; preserve existing Promise-valued synchronous memo behavior.                                  | Pending  |
| A3   | Pending/error states compose through synchronous derived nodes and effect/render consumers with defined commit semantics.                                             | Chains, diamonds, conditional subscriptions, independent boundaries, error recovery, no unintended partial commits, and cleanup ordering.                                                     | Pending  |
| A4   | Resource uses the shared async computation protocol while retaining its data/cache policies.                                                                          | Existing resource/cache/TTL/SWR/LRU/sharing/optimistic/SSR regressions and new graph-composition coverage.                                                                                    | Pending  |
| A5   | Transition readiness accounts for registered downstream async work caused by updates, including indirectly triggered requests.                                        | Overlapping transitions, unrelated roots, stale completions, callback failures, disposal, and the indirect-resource regression.                                                               | Pending  |
| A6   | Compiler-owned async declarations, types, runtime helpers, and cross-module contracts use the same graph protocol.                                                    | Native strict compilation, source maps, metadata/ABI checks, reactive input updates and lifecycle checks; explicit supported continuation boundaries.                                         | Pending  |
| A7   | Async graph behavior works through SSR, streaming, hydration, and request isolation.                                                                                  | Real server/browser tests covering initial pending, refresh, errors, cancellation, serialization and compatible hydration.                                                                    | Pending  |
| A8   | Representative applications and documentation demonstrate the unified model and its migration boundaries.                                                             | End-to-end async application scenarios, usable examples, API/package checks and synchronous performance regression checks.                                                                    | Pending  |
| Q1   | The final stack satisfies each row against the current source and artifacts.                                                                                          | Full applicable compiler/runtime/SSR/bundler/strict/browser gates, per-item commits, fresh final audit, and explicit evidence for every completion claim.                                     | Pending  |

Changes must preserve observable JavaScript behavior: reference/receiver semantics,
coercion, evaluation and cleanup ordering, exceptions, explicit memo caching,
keyed object replacement, and user-owned lifecycle boundaries. Optimization
decisions must account for work already avoided by the runtime.

The async contract starts from explicitly registered computations. Ordinary
Promise values retain their authored JavaScript meaning. Compiler-supported
continuations need an explicit ownership/tracking contract; arbitrary detached
asynchronous tasks cannot be inferred from their position in application source.

Performance qualification measures complete application workloads and does not
equate fewer nodes with less total work. Measurements must run without concurrent
builds, tests, or profiles. Historical measurements remain labeled as historical
until their source and build relationship is verified.

## S1: explicit primitive snapshots

The documented `untrack(() => externalFormat(count))` example now compiles with
strict guarantees when the component's state remains provably primitive. Direct
snapshot results and immutable snapshot aliases can cross an opaque value boundary.
Mutable references, externally writable hook state, asynchronous callbacks, and
retained reactive closures keep their diagnostics. This permission is tied to the
imported Fict function, including renamed imports, rather than its spelling.

Validation: 4 focused Rust integration tests covering disabled/safe/full compiler
profiles and adversarial cases; 198 compiler unit tests; 129 native runtime,
accessor, optimizer-differential, and build-identity tests. The cookbook example is
read directly by a test. DOM checks verify one-time evaluation, unchanged snapshot
values after updates, and exception propagation. Both compiler complexity and Rust
crate/diagnostic/EmitIR guardrails pass. The Rust crate budget accounts for the 182
new integration-test lines; the production orchestration budget is unchanged.
