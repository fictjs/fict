# Reactivity stack qualification: 2026-09-14

Local qualification of the implementation checklist has passed. The complete
Rust workspace gate and the final `pnpm commit` preflight both finished
successfully. The performance target and retained architecture boundaries below
remain explicit limits of this result.

This audit covers the implementation following the 0.35.0 review of `af3d5fc0`.
The [implementation checklist](./reactivity-implementation-plan.md) records each
independent item and its evidence. Compiler/runtime production source is unchanged
since the measured `6a716534` tree: all 386 recorded production inputs match
byte-for-byte. The native addon is identical to both the benchmark and strict
application artifact. Later commits add documentation, examples, evidence, tests
and CI/budget governance.

| Area                  | Qualified behavior                                                                                                                                                          | Evidence                                                                                                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Strict boundaries     | Binding-aware runtime hosts, explicit primitive snapshots, collection/factory contracts, custom metadata hosts, strict application builds                                   | S1–S7 and the [application archive](./testing/async-application-evidence-2026-09-14.json)                                                                                            |
| Compiler optimization | Safe single-consumer JSX inlining, unused total-scalar memo removal, analyzed versus rewritten SSA counters, source/plan/final-output traces                                | [G1](./testing/jsx-memo-inline-evidence-2026-09-14.json), [G2](./testing/reactive-graph-trace-evidence-2026-09-14.json), [G3](./testing/unused-scalar-memo-evidence-2026-09-14.json) |
| Async graph           | Owned async computations, readiness through derived/render consumers, shared Resource protocol, causal transitions, explicit compiler declarations, SSR and eager hydration | A1–A8 and the [graph contract](./async-graph-contract.md)                                                                                                                            |
| Runtime cost          | Fewer binding allocations, separate repeated CPU and forced-GC page-memory measurements                                                                                     | [G4](./benchmarks/runtime-creation-cost-2026-09-14.json), [G5](./benchmarks/runtime-qualified-2026-09-14.json)                                                                       |
| Continuous coverage   | Normal CI and release use the same complete native behavior entry point                                                                                                     | [Q1a](./testing/native-ci-suite-evidence-2026-09-14.json)                                                                                                                            |

The current five-framework CPU score is **1.1131642824390815**. Both complete
rounds and the pooled score **fail the unrounded ≤1.10 target**. The adopted
allocation change reduces 1k live page memory by 3.20% in its controlled comparison;
its repeated CPU results do not establish a stable overall speed improvement.
README is checked directly against the raw samples, versions and artifact hashes.

The [final validation report](./testing/reactivity-final-evidence-2026-09-14.json)
records 24 successful command gates, production/native/application identities,
per-item evidence hashes and the three resolved qualification failures. The
[portable log archive](./testing/reactivity-final-logs-2026-09-14.tar.gz) contains
27 logs, including the original failures and passing reruns.

| Gate group                 | Result                                                                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Complete Rust workspace    | fmt, all-target/all-feature Clippy, 55 test programs and eight doc-test groups; 893 cases pass, zero ignored or failed; all 60 Rust guardrail tests and crate/diagnostic/EmitIR checks pass |
| Native compiler behavior   | All 621 cases pass; host, public types, local native-package installation and capability release gate pass                                                                                  |
| Runtime                    | Workspace tests include 1,548 passing runtime cases and eight existing skips; explicit-GC stress, ABI and distributed ESM/CJS consumers pass                                                |
| Packaging and integrations | Nine package tarballs, typed ESM/CJS consumers, Vite, Webpack, playground, VS Code and runtime bundler smoke pass                                                                           |
| Applications and SSR       | Fresh strict application corpus, strict bundlers, SSR matrix, full E2E and streaming/browser checks pass; all 15 app/library source hashes still match                                      |
| Commit preflight           | Release/API/Preview boundaries, strict candidate types, build, frozen corpus, distributed size, review regressions, workspace tests, production/test types, formatting and lint pass        |

The `pnpm commit` log advances from its successful `precommit` lifecycle into
Commitizen. The final evidence and completion text are then sealed in the
containing Git commit; those documentation edits receive a final format/link,
archive-integrity and README-data check. The record does not claim that a Git
commit hash existed before the commit was created.

Three final checks required corrections, each in a separate commit:

- `05867346` restores the previously approved migration-guide bytes and places
  new async guidance in a separate document. Historical evidence and human
  approval records are unchanged.
- `1429c1fe` updates the source-map probe to the live `__fictProp` output and
  verifies both wrapper and inner-read origins in both DOM paths.
- `84dde2f8` accounts for exactly 82 added compiler-host protocol/metadata lines,
  preserving the previous maintenance reserves and every ratchet rule.

A8's archived migration-document hashes describe its earlier snapshot. The final
report binds the current [async migration guide](./async-migration-guide.md) and
navigation; all application and production source bytes remain unchanged.

## Boundaries retained after qualification

- Ordinary Promise-valued memos preserve their authored meaning. `$async` and
  `createAsyncMemo` opt into resolved-value readiness; native `await` does not
  carry tracking or ownership into a continuation.
- Async component functions and Preview serialization of async ownership retain
  their unsupported ABI diagnostics. SSR uses explicit request ownership and
  application-data handoff for eager hydration.
- Resource keeps cache/transport policy and its refresh UI contract. Prepared
  effects require pure preparation; arbitrary side effects are not rolled back.
- General cost-based region fusion/splitting, arbitrary SSA/Phi substitution and
  branch/lifetime-aware memo placement remain retained work. Static trace counts
  are not dynamic allocations or a proof of globally minimal cost.
- The table fixture still expresses selectors, per-row signals and stable row
  captures explicitly. The compiler does not infer that representation for all
  applications.
- Eight maintained application fixtures are repository evidence, not eight
  independent external migrations or proof of a universal strict-boundary rate.

This is local Darwin arm64 qualification. Remote CI, other platform executions,
registry publication and deployment are separate evidence boundaries.
