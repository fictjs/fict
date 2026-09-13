# Reactivity implementation and qualification

This checklist tracks the implementation requested after the 0.35.0 architecture
review of `af3d5fc0`. Each independent item receives its own commit, implementation
evidence, and applicable validation. A checked item must describe working behavior,
not only an analysis pass, an API sketch, or a passing unrelated test suite.

| Item | Required result                                                                                                                                                       | Completion evidence                                                                                                                                                                           | Status   |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| S1   | Explicit snapshot semantics and diagnostic fixes agree under default strict compilation. Retained reactive closures and unsafe lifetime escapes remain diagnosed.     | Executable cookbook examples, adversarial native compiler tests, disabled/safe/full behavioral checks.                                                                                        | Complete |
| S2   | Official selector and reactive callback APIs are recognized by binding identity and their actual tracking/lifetime contracts.                                         | Positive imports/aliases and negative shadowed, external, deferred, and reassigned-host cases.                                                                                                | Complete |
| S2b  | Known runtime factory results preserve Resource getter and transition callback contracts, including reactive Resource views.                                          | Strict marked-getter, alias/mutation, VNode/direct DOM, causal readiness and disposal checks discovered during application qualification.                                                     | Complete |
| S2c  | JSX calls retain consumer tracking and component prop/children value contracts in direct DOM and VNode output.                                                        | Six output profiles; live helper calls, callback identity, snapshots, key evaluation, await/source-map and reviewed corpus checks.                                                            | Complete |
| S3   | Collection/fresh-copy analysis and explicit per-row signal boundaries support the optimized keyed fixture with strict guarantees.                                     | Strict fixture compilation, precise alias/mutation regressions, same-key replacement and teardown behavior.                                                                                   | Complete |
| S4   | Custom compiler host environment and metadata obligations are executable and documented.                                                                              | Facade/native integration contract tests, missing metadata cases, consumer package checks.                                                                                                    | Complete |
| S5   | Representative application coverage measures strict boundary incidence and usable diagnostic repairs.                                                                 | Maintained corpus with source identity, diagnostics, boundary/LOC counts, migration evidence, strict production and browser gates; distinguish maintained fixtures from independent adoption. | Complete |
| S6   | Local build caches include the native compiler source and artifact identity used by each host.                                                                        | A changed compiler invalidates dependent build tasks; final qualification forces fresh application builds.                                                                                    | Complete |
| S7   | Bundle-size gates resolve distributed modules without silently following workspace source aliases.                                                                    | Actual ESM/CJS package measurements, import-specific budgets, and an executable resolution check.                                                                                             | Complete |
| G1   | Safe implicit memos with one logical JSX consumer can be removed without erasing observable computation or ownership semantics.                                       | Native output and browser/SSR behavior across safe/full/disabled options, explicit memo, multi-consumer, coercion, errors, and cleanup controls.                                              | Complete |
| G2   | Reactive allocation and optimization decisions are traceable from source consumers through EmitIR to generated bindings and owners.                                   | Verified graph/decision information and final-output counters, including reasons for materialization, inlining, retention, and rejected fusion.                                               | Complete |
| G3   | Existing SSA simplification facts and lazy placement opportunities are either safely realized in emitted code or accurately reported as retained work.                | Semantic differential tests and final generated-code evidence; no claims based solely on unused analysis fields.                                                                              | Complete |
| G4   | Creation, replacement, and append costs are profiled and reduced where measurements support safe changes.                                                             | Controlled allocation/CPU profiles, complete repeated benchmark batches, memory and disposal checks, documented rejected experiments.                                                         | Complete |
| G5   | README performance claims correspond to the qualified strict build and identify versions, artifact hashes, normalization, uncertainty, and the unrounded 1.10 target. | Frozen source/build provenance, complete keyed/browser checks, reproducible archive and README data validation.                                                                               | Complete |
| A1   | An async graph contract specifies readiness, stale/current values, invalidation, errors, effect commit, ownership, and compatibility.                                 | Implementable state transitions and executable acceptance scenarios, not percentage scores.                                                                                                   | Complete |
| A2   | An explicit async computation is a reactive graph node, including Promise and async iterable completion, invalidation, and cancellation.                              | Graph-level dependency/status behavior, stale-flight rejection, cancellation and disposal tests; preserve existing Promise-valued synchronous memo behavior.                                  | Complete |
| A3   | Pending/error states compose through synchronous derived nodes and effect/render consumers with defined commit semantics.                                             | Chains, diamonds, conditional subscriptions, independent boundaries, error recovery, no unintended partial commits, and cleanup ordering.                                                     | Complete |
| A3b  | Keyed lists retain async subscriptions while their live owner parks DOM in Suspense.                                                                                  | Initial pending, refresh, same-key row identity, superseded results, disposal, existing list/async suites and runtime typechecks.                                                             | Complete |
| A3c  | Async-dependent memos propagate recovery even when their last successful values compare equal.                                                                        | Resource key-switch and async source-replacement regressions, subsequent subscriptions and disposal, full runtime/Resource suites.                                                            | Complete |
| A4   | Resource uses the shared async computation protocol while retaining its data/cache policies.                                                                          | Existing resource/cache/TTL/SWR/LRU/sharing/optimistic/SSR regressions and new graph-composition coverage.                                                                                    | Complete |
| A5   | Transition readiness accounts for registered downstream async work caused by updates, including indirectly triggered requests.                                        | Overlapping transitions, unrelated roots, stale completions, callback failures, disposal, and the indirect-resource regression.                                                               | Complete |
| A6   | Compiler-owned async declarations, types, runtime helpers, and cross-module contracts use the same graph protocol.                                                    | Native strict compilation, source maps, metadata/ABI checks, reactive input updates and lifecycle checks; explicit supported continuation boundaries.                                         | Complete |
| A7   | Async graph behavior works through SSR, streaming, hydration, and request isolation.                                                                                  | Real server/browser tests covering initial pending, refresh, errors, cancellation, serialization and compatible hydration.                                                                    | Complete |
| A8   | Representative applications and documentation demonstrate the unified model and its migration boundaries.                                                             | End-to-end async application scenarios, usable examples, API/package checks and synchronous performance regression checks.                                                                    | Complete |
| Q1a  | Normal CI executes the same complete native behavior suite as local and release qualification.                                                                        | Canonical root command, legacy domain coverage assertions and current compiler/CI contract checks.                                                                                            | Complete |
| Q1b  | Async migration documentation preserves immutable legacy-removal approval evidence.                                                                                   | Original guidance digest retained; separate async guide and updated navigation; rollout-state and documentation checks.                                                                       | Complete |
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

## S2: runtime callback identities and lifetimes

Official selector sources now participate in the existing strict contract.
Named imports, immutable aliases, and ESM namespace members share the runtime
contract. Ordinary object properties and reassigned or unrelated functions do not.
The selector's equality callback cannot introduce independently changing reactive
captures. Synchronous runtime hosts do not silently accept reactive async or
generator continuations; a proven primitive snapshot captured before scheduling is
an ordinary transferable value.

The change also removes an accidental name-based exemption for external functions
called `createMemo`, `createEffect`, `createSelector`, or `render`. Compiler macros
keep their separate HIR call kind. DOM tests cover three optimizer profiles,
subscription updates and disposal, and deferred snapshot consumption.

Validation: 198 compiler unit tests, 9 strict integration tests, and 390 native
compiler/DOM/SSR/source-map/optimizer tests pass. All 1,950 primary corpus inputs
and 1,221 non-preview replay inputs were compared against their prior status,
diagnostics, and generated-code digest. Only 3 primary and 19 replay diagnostic
sets change: redundant R002/R005 warnings are removed from official callback
hosts. Generated code and acceptance status remain identical, including R004
placement errors, S002 warnings, and the two explicit non-strict warning overrides.
The diagnostic review records those exact changes; legacy Babel source, generated
output, and acceptance-deviation policies are preserved. The corpus references and
diagnostic-deviation counts are updated together and pass their 32 contract tests.

Both frozen replay suites pass, covering 3,172 inputs including the one Preview
fixture, with deterministic checks twice per input. The complete `pnpm commit`
preflight, build, corpus, bundle-size, review-regression, workspace-test, typecheck,
format, and lint sequence passes.

## S2b: local runtime factory result contracts

Application qualification exposed missing return-value knowledge for Resource
views and transition handles. Intact local `resource` results now certify
`read(reactive(getter))` and preserve the view's reactivity. The marker remains
explicit: ordinary function arguments remain data and live unmarked captures
retain their strict boundary.

Verified HIR binding facts distinguish manual accessors, stable methods and
containers. This preserves `pending` function identity, updates direct and
derived pending labels in both DOM backends, and avoids incorrectly materializing
an extracted `start` or `read` method as an implicit memo. The facts are visible
in HIR output and validated before downstream analysis.

Proofs follow official import identities, direct immutable aliases and intact
method/tuple projections. Overwrites, reassigned aliases, mutable nested storage,
exports, returns, throws, yields, unknown hosts and modified array iterators
remain conservative boundaries. This does not infer borrowed container lifetimes
or add cross-package metadata for manually returned transition accessors.

Validation: all 484 native compiler tests pass, including nine new grouped cases
covering six optimizer/DOM profiles, executable README/cookbook examples, key
changes, causal readiness, stale completions, function identity, cancellation and
disposal. The retained baseline reproduces all 3,172 frozen inputs; acceptance,
diagnostics, generated code and recorded deterministic results remain unchanged.
Rust all-target/all-feature Clippy, HIR contracts and 57 compiler/corpus/complexity
guard tests pass. The [evidence archive](./testing/runtime-factory-contract-evidence-2026-09-14.json)
records source and native artifact identity. No CPU or memory samples are inferred
from this correctness qualification. The complete `pnpm commit` preflight, fresh
workspace build, frozen corpus, bundle-size, review-regression, workspace-test,
typecheck, format and lint sequence also passes.

## S3: strict collections and the optimized keyed fixture

Direct built-in array annotations enter alias analysis before method calls are
classified. Immutable aliases and certified fresh-copy results retain their
receiver family in HIR; arbitrary nested properties do not inherit that family.
Dynamic array element reads remain reactive. Proven scalar results such as
`findIndex` can occupy built-in index/count positions, while inserted closures,
object arguments, deep mutation, and overwritten methods retain their boundaries.

The optimized fixture now requires strict compilation with zero diagnostics. Its
selector, per-row signals, text bindings and stable row captures remain explicit
representation choices. The event update uses one `untrack` inside the batch;
removal uses a shallow copy directly. This does not add general local-function
borrowing or assume runtime signal identity from a structural function type.

Validation: all 468 native compiler/DOM/SSR/optimizer tests pass, including 11 new
collection cases and a prior projected-assignment case upgraded from warning
opt-out to strict success. The six compiler profiles cover disabled/safe/full
optimization and both DOM backends. Keyed row components preserve DOM identity
and subscribe to replacement signals under the same key; stale signal writes no
longer affect them, and each row cleanup runs once. The generic VNode backend
retains its existing array replacement behavior.

Both frozen Rust replay suites pass with deterministic checks twice per input.
The retained baseline addon also reproduces all 3,172 prior inputs: acceptance and
generated code are unchanged, with six redundant array-access warnings removed
from three diagnostic sets. The [review archive](./benchmarks/strict-collection-review-2026-09-13.json)
records each removal; all 32 corpus-policy checks, Rust boundaries and Clippy pass.

Final-stack Rust qualification found one older regression still expecting a direct
variable array annotation to fail. Its contract now accepts both the macro type
argument and the declaration annotation introduced by S3. An RHS assertion alone,
a type alias, or a shadowed `Array` declaration remains rejected. The retained
pre-G1 native addon independently confirms that acceptance boundary; the focused
Rust contract and all 42 reactive-write tests pass. This corrects the old assertion
without changing compilation.

The [strict production fixture archive](./benchmarks/strict-runtime-fixture-2026-09-13.json)
contains its source, compiled output, native/build provenance and served bundle
hash. Chrome passes 15 model checks through 11,000 rows and the official keyed
create/remove/swap checks. These are correctness checks. No new CPU or memory
samples were collected, and README now explicitly labels its prior 0.34.0 table
as historical. Current-stack timing and the unrounded 1.10 target remain G4/G5.

## S4: custom compiler host contracts

The [executable host recipe](./custom-compiler-host.md) scans value imports, resolves
current metadata snapshots, and rejects missing or provisional graph output before
final emission. Its actual source is executed by the native and isolated package
consumer gates. Metadata changes alter generated accessor reads and fingerprints;
type-only edges do not cause runtime resolution. A known Fict library that loses
its package declaration remains an error. An `opaque` classification is explicitly
documented and tested as a host trust boundary, not automatic proof of plain code.

The analyze environment helper is now public alongside the compile helper. Raw
native calls see serialized options only, while root and native facades enforce
current process policy on every call. Both ESM and CJS checks exercise development,
production, forced strict mode, explicit build environments, sync/worker-pool APIs,
and unchanged caller requests. Authoritative virtual package metadata now receives
the same schema validation as metadata read from disk.

Validation: 475 native tests, 119 compiler unit tests, 35 native packaging contracts,
production compiler typecheck, and ESM/CJS consumer declaration checks pass. Three
optimizer profiles execute a real compiled hook and consumer through updates and
disposal. An isolated local tarball install without a Rust toolchain passes 66 host
policy assertions per format, the executable metadata recipe, and all 1,950 primary
frozen corpus cases. The [evidence archive](./testing/custom-host-evidence-2026-09-13.json)
records source hashes, native artifact identity, and package results. This is local
Darwin arm64 consumer evidence, not a registry publication or remote platform result.

## S6: compiler-aware build caching

Workspace Turbo commands pin the selected native addon and hash its actual bytes.
The cache also includes Rust sources and build manifests, compiler capabilities,
and diagnostics. The absolute addon path passes through to compiler hosts without
making identical binaries machine-specific cache inputs. A missing default addon
forces task execution; an explicit missing override fails before any task runs.

Validation uses a real isolated Turbo workspace: unchanged inputs hit the cache,
Rust edits invalidate it, replacing addon bytes at the same path invalidates it,
and relocating identical bytes retains the cache hit. Both integration tests and
all 55 release-verification checks pass. A fresh root `pnpm build --summarize`
executes all 31 tasks successfully with zero cache hits. The cache test runs in CI,
precommit, and release verification.

## G1: single-consumer scalar JSX memos

Implicit derived values used once as intrinsic JSX text can now inline through
generated consumer getters and namespace alternatives. The proof runs on authored
bindings before cloning: component-owned numeric/boolean/nullish state must start
in the same straight-line owner and retain that domain through every write.
Generated reads must match both the original binding and spelling. Existing
same-owner inlining retains its original checks.

Explicit memos, multi-consumer values, component props, uncertain calls/coercions,
object or externally owned state, conditional initialization, async accessors,
and mutable string recurrence retain materialization. The
[inlining guide](./derived-memo-inlining.md) specifies the supported boundary;
its source example is compiled by the regression suite.

Validation: all 566 native compiler tests pass after a fresh build, including
40 focused cases across disabled/safe/full optimization and both DOM backends.
The retained baseline passes 25 of those cases and fails the 15 new optimization
expectations. Twenty-four Chromium scenarios cover HTML/SVG structure, updates,
equal-result DOM identity, hide/remount and disposal using distributed packages.
SSR, exception and cleanup checks pass separately in the native suite.

Both frozen replay suites pass: all 3,172 inputs retain their acceptance and
diagnostics. Manual and binding-aware AST review limits the 22 changed outputs to
26 removed implicit memo declarations, 51 accessor substitutions and associated
imports. Source requests, Babel outputs, maps and capture policies are unchanged.
All-target/all-feature Clippy, Rust boundaries and 101 corpus/oracle/guard checks
pass. The [evidence archive](./testing/jsx-memo-inline-evidence-2026-09-14.json)
records compiler/source identities and browser build hashes. These are static
output and correctness results; no CPU improvement or 1.10 score is inferred.
The complete `pnpm commit` preflight also passes, including the fresh workspace
build, frozen corpus, distributed size limits, review regressions, workspace
tests, production/test typechecks, formatting and lint.

## G2: source, plan and final-output tracing

`options.explain` now includes an optional versioned
[reactive graph trace](./reactive-graph-trace.md). It preserves source binding and
reference identities, EmitIR slots and operation indices, known storage/cleanup
owners, operation purposes, actual inline decisions, and resolved helper calls
in the reparsed main output. Independent TypeScript parsing checks final call
spans, lexical parents and counts in ESM/CommonJS, both DOM backends and all
three optimizer profiles. Source reference counts do not count generated namespace
copies as additional authored consumers.

The trace separates planned work from final call sites. It reports preserved
explicit/runtime creations, policy restrictions, shared or unused memos,
uncached derivations, and missing movement/lifetime proofs. General fusion is
explicitly not attempted. Static function/call counts do not claim dynamic node
counts, CPU cost, imported implementation coverage, or Preview handler-artifact
coverage. Synthetic source/operation associations remain absent when unproved.
The existing result-payload limit also bounds explanations.

Validation: all 588 native compiler tests pass, including 22 graph cases, real
ESM/CJS facade examples, worker-pool parity, effect/event cleanup identities,
source captures, limits and independent output parsing. Tracing on/off is
observational across all 3,172 frozen requests; 2,807 accepted requests produce a
reconciled trace. Compared with the retained G1 addon, every complete result is
unchanged after excluding timing/build identity and removing the new graph field.
Only five already-explained replay fixtures need deterministic digest updates;
JavaScript, maps, diagnostics, metadata, artifacts, existing explain events and
core counters remain identical. Primary corpus/oracle hashes and all legacy
capture data are preserved.

Both Rust frozen replay suites, all-target/all-feature Clippy, 119 compiler package
tests, compiler typechecking/lint and 63 corpus/guard contract tests pass. The
[evidence archive](./testing/reactive-graph-trace-evidence-2026-09-14.json) records
the five reviewed reports and exact source/native identities. No CPU or runtime
allocation improvement is attributed to this observational feature.

## G4: measured binding allocation reduction

Managed render bindings now keep their prepared value in the existing effect
owner, removing a separate captured value cell and two forwarding closures.
Preparation still precedes cleanup and commit; ordinary callbacks receive no
arguments, while a binding commit receives exactly its prepared value. Node
counts, subscriptions, cancellation, error routing and disposal remain unchanged.

The [creation-cost archive](./benchmarks/runtime-creation-cost-2026-09-14.json)
preserves both strict, zero-diagnostic builds, identical compiled fixture output,
60 raw CPU/allocation profiles, two complete official CPU rounds (580 samples),
and 18 separate forced-GC page-memory samples. Reverse ordering changes the
overall CPU direction: candidate/baseline is 1.005786 in round A and 0.988070 in
round B. The pooled ratio 0.996874 does not establish a stable overall speed win.
Pooled 1k creation and append are slightly slower; 10k creation script time and
clear improve in both rounds.

Allocation sampling estimates 4.6%–8.4% fewer bytes for creation, replacement and
append. Live page memory after 1k rows falls from 4.691704 to 4.541471 MiB, or
3.20%; ready and cleared pages remain effectively flat. The change is adopted for
those allocation and memory savings, with the CPU tradeoffs recorded explicitly.
Historical ID-effect removal and class/label fusion remain rejected experiments,
not qualified optimizations on this stack. G5 separately measures all five
frameworks and the unrounded 1.10 target.

Validation: 1,548 runtime tests, four explicit-GC stress tests, 615 native compiler,
DOM and SSR cases, source/test typechecks and runtime lint pass. Both frozen
entries pass 15 browser model checks through 11,000 rows and all three official
keyed checks. Profiles, tests, builds and CPU/memory batches run separately.

## G5: current strict five-framework results

README now reports the qualified 0.35.0 compiler/runtime at `6a716534`, including
the async graph. Both complete nine-case CPU rounds retain all 1,450 reported
samples. Round B reverses case and framework order. The pooled Fict score is
1.1131642824390815, versus 1.1136580376192835 and 1.1142133406712187 per round.
The unrounded 1.10 target **does not pass**. Completion of this item certifies
accurate measurement and reporting, not achievement of that performance target.

The [qualification archive](./benchmarks/runtime-qualified-2026-09-14.json)
contains all records and commands, source/build identities, reference versions,
and a compressed 73-file source/artifact/harness snapshot. It also contains a
separate 45-sample page-memory batch. All five entries pass the official keyed
checks; Fict passes 15 model checks through 11,000 rows. The first successful
round was recovered after a collector version-label error without rerunning
measurements or replacing samples.

The README checker recomputes sample means, round and pooled scores, the exact
target result, versions and the build reference, and verifies the frozen artifact
hash. It runs in the shared review-regression gate. Historical 0.34.0 results stay
in the benchmark history; neither CPU improvement nor isolated async overhead is
inferred by comparing those separate historical batches. The current creation
script/paint split and remaining target budget are documented explicitly.

## A1: executable async readiness contract

The [async graph contract](./async-graph-contract.md) defines current versus stale
reads, generation replacement, rejection identity, stream readiness, empty streams,
terminal disposal, cancellation, ownership, preparation/commit effects, transitions,
Resource policy, and compiler/server compatibility. `AsyncState` implements the
shared state protocol without independent loading/error/value signals. Node and
host integration remain separately tracked by A2 through A8.

Fifteen executable tests cover the state transitions, all six settlement orders
for three generations, duplicate and stale results, iterator completion and
failure, disposed waiters, immutable snapshots, arbitrary rejection values, and
ordinary Promise-valued synchronous memo behavior. Production and test typechecks
cover the new protocol. This foundation does not claim that the remaining async
integration work is complete.

## A2: explicit async computed nodes

`createAsyncMemo` in the advanced entries uses one computed node for both input
subscriptions and readiness snapshots. It supports synchronous results, captured
thenables, and async iterables; current and stale reads, refresh, cancellation,
and terminal disposal share the A1 protocol. Activated nodes check invalidations
even when only imperative readiness waiters remain. Each producer generation owns
its cleanup root. Ordinary synchronous memo semantics stay unchanged.

Thirty-five protocol/node tests cover publication races before a scheduled flush,
conditional/equal inputs, temporary unsubscription, method getter/receiver semantics,
per-generation cleanup, disposal from inside production, throwing cleanup, recursive
reads, streams and empty streams, stale rejections, and cleanup snapshots when an
async publication starts the next flush. Production/test typechecks, package ESM/CJS
consumer probes, native compiler behavioral tests, and workspace builds pass.

The [size comparison](./benchmarks/async-node-size-2026-09-13.json) identifies source
and artifact trees. Cached baseline sourcemaps were checked against `3d763bfd`.
The existing workspace checks grow from 22,076 to 22,119 B for ESM and from 24,021
to 25,505 B for CJS (production Brotli). Their limits are updated to the measured
new API cost, with a separate 6.5 KB async-import gate. The audit also found that
those legacy checks resolve runtime source aliases: actual distributed modules
measure 22,135 B ESM and 40,982 B CJS, versus baseline 22,033 and 39,477 B. S7
separately corrects that measurement boundary. No CPU benchmark score is inferred
from these bundle measurements. Composition and integration remain tracked by A3–A8.

## S7: distributed package size boundaries

Size checks now disable tsconfig path mapping and inspect esbuild's actual module
inputs. Loading a workspace `packages/*/src` file fails the check. Three executable
boundary tests cover all configured entry points, deliberately restore a conflicting
source alias to verify rejection, and reject a direct source entry point. The gate
runs inside `pnpm size`, including its existing CI, precommit, and release callers.

The four production Brotli checks pass against distributed artifacts: complete
ESM 22,135 B, complete CJS 40,982 B, the async memo import 6,905 B, and the sync memo
import 4,309 B. Limits reflect those actual artifacts, with the earlier aliased
measurements retained in the dated A2 archive rather than relabeled as package
results. No runtime code or CPU performance measurement changes in this item.

## A3: async consumers and render commits

Synchronous memo chains retain the dependency paths required to recover from
pending or failed async inputs. Async-to-sync-to-async chains wait on upstream
readiness instead of treating a pending token as a rejection. Exact rejection
identity is preserved, including `undefined`, `NaN`, Promises, and branded tokens.
Ordinary synchronous memos retain their existing initial-error retry behavior.

`createAsyncEffect(prepare, commit)` uses a single prepared effect node. Preparation
tracks current inputs before cleanup; commit runs untracked in its own cleanup
root. DOM value bindings use the same preparation mechanism, while structural
views retain their explicit prepare/commit ownership. An abandoned conditional
consumer releases its boundary wait without waiting for an irrelevant transport.

Graph-aware Suspense retains owners and live DOM ranges during fallback, defers
nested mounts, and handles resets and fallback-cleanup reentrancy. Legacy tokens
retain replay semantics. Pending reads in synchronous component setup receive an
explicit diagnostic directing them to a reactive binding or preparation; this does
not introduce an async component ABI or tracking across native `await`.

Validation: 29 new composition/render tests, 1,516 passing runtime tests (8 existing
skips), 390 native compiler/DOM/SSR tests, production/test typechecks, all 31 workspace
build tasks, and real distributed ESM/CJS imports. The
[composition size archive](./benchmarks/async-composition-size-2026-09-13.json)
records source/artifact identities and the added shared runtime cost. Its sync-import
measurement is separate from complete-package cost. CPU and application performance
remain to be qualified by G4/G5/A8; no historical benchmark score is relabeled.

## A4: Resource on the shared async graph

Each cache entry now owns one async source node using the same readiness,
publication, and generation protocol as async memos. Resource retains transport,
cache keys, TTL/SWR, sharing, request scoping, and mutation policy. Lazy shared
field projections preserve independent data/loading/error equality without a
second imperative async state machine. Reactive Suspense consumers compose
through derived nodes and retain their owners; legacy setup reads keep replay
compatibility. Reset tokens replace pending generations, and LRU eviction keeps
live readers' settled snapshots intact.

Validation: 12 new source/policy integration cases, all 54 Resource tests, 67
runtime async tests, production and test typechecks, 390 native compiler/DOM/SSR
regressions, and all 31 workspace build tasks. The new Resource test typecheck is
included in root CI/release/precommit gates. The
[Resource size archive](./benchmarks/resource-async-graph-size-2026-09-13.json)
verifies source maps and records distributed artifact hashes. Its new selective
Resource gate measures 20,700 B Brotli; main ESM and sync-memo import sizes stay
unchanged. This is an architecture/policy qualification, not a CPU speed claim.

## A5: causal transition readiness

Transition scopes now follow signal writes through queued effects, activated async
computations, and downstream publications. Write identity distinguishes an obsolete
same-input update from simultaneous updates to different inputs. Pending includes
registered graph generations and the callback's returned Promise; equality skips,
replaced generations, and disposal release their accounting. Ordinary synchronous
updates allocate no transition bookkeeping.

Resource readers hold independent readiness leases on a shared request. Switching
keys can end an obsolete view's wait while retaining useful cached transport;
removing one reader does not release another reader's lease. Hook-owner disposal
ends its scopes. Native await/timer continuations keep their explicit registration
boundary, documented alongside the unchanged public signatures.

Validation: 14 new runtime cases and 5 Resource cases, existing scheduler and
Resource regressions, the full runtime suite, production/test typechecks, all 31
workspace builds, 390 native compiler/DOM/SSR tests, and actual distributed ESM/CJS
memo and Resource probes. The
[causal transition size archive](./benchmarks/causal-transition-size-2026-09-13.json)
verifies 98 source-map entries and records source/artifact identities. Complete ESM
adds 623 B Brotli and the sync memo import adds 140 B. All five package/import
budgets include the measured cost; no CPU-performance result is inferred.

## A6: explicit compiler async declarations

`const value = $async(producer)` in `fict` and `fict/slim` lowers to the A2 async
node and exposes its resolved value, including callable values. The compiler,
types, runtime helper ABI and metadata agree on `async` value getters versus
`asyncAccessor` manual objects. Direct immutable accessor aliases retain identity;
conditional selections retain their actual generated getter layer. Ordinary
module declarations remain snapshots. The same derived-getter plan informs
metadata and emission, preventing disagreement across package boundaries.

Producer generations create nested synchronous computations in their runtime
owner instead of component hook slots. Strict diagnostics reject unsupported
native continuations, mutable/retained escapes, writes, nested async dependency
construction and Preview serialization. These are explicit supported boundaries,
not automatic tracking across native `await`. The
[declaration guide](./async-declarations.md) includes an executable example.

Validation: 48 async native cases and 438 complete native compiler/DOM/SSR/oracle
regressions pass against the release addon. They cover disabled/safe/full
optimization, template/VNode output, real ESM metadata consumers, CommonJS,
source maps, generation cleanup, callable values, receiver preservation and
alias selections. A 48-layer shared-branch regression prevents exponential
metadata traversal while retaining conflicting-branch checks. Type inference,
runtime ABI, closed metadata validation and the real Vite build/pack/install
consumer pass. All 31 workspace build tasks execute successfully; diagnostic,
crate-boundary, source-complexity and EmitIR guards pass.

The [size archive](./benchmarks/compiler-async-declarations-size-2026-09-13.json)
verifies 98 source-map entries and source/artifact identities. Distributed CJS
adds 47 B Brotli and the sync memo import adds 3 B; all five existing budgets
pass unchanged. SSR streaming/hydration qualification remains A7, and CPU
performance remains G4/G5/A8.

## A7: async SSR, streaming and eager hydration

The public Core `hydrate` API attaches client ownership to completed server
output. Transparent eager component hosts tolerate independent minification;
Preview hosts retain their stable resume-entry identity. Paired Suspense,
ErrorBoundary and child ranges preserve owned DOM through initial pending,
refresh and error recovery. Fragment claims keep nodes connected, including
focus, input values and selection. Strict hydration failures escape application
ErrorBoundary handlers; repair mode rebuilds damaged ranges within their owner.
Independent roots keep separate hydration options and cleanup ownership.

Server and client share the async readiness protocol. Requests own their graph,
AbortSignals and iterator cleanup. Out-of-order completions and disconnected
transports cannot publish into another request. Applications hand off explicit
JSON-safe initial values after the shell stream and its patches finish; this does
not resume native continuations or serialize graph nodes. Preview serialization
of compiler async slots fails explicitly. The
[SSR/hydration guide](./async-ssr-hydration.md) documents that handoff and its limits.

Native VNode and namespace fallback output now wraps JSX getter bindings using
their original semantic identities, recorded before AST cloning. The
[code-generation review](./benchmarks/async-ssr-codegen-review-2026-09-13.json)
records 108 primary and 81 replay output changes. Baseline output digests were
reproduced before comparison: 358 reactive consumers and their helper imports
are added, with no other AST changes or removed consumers. All 3,172 input
statuses and diagnostics remain unchanged. Frozen Babel outputs and semantic
expectations are preserved; SSR text comparisons canonicalize the new internal
child-start marker alongside the existing child/slot markers.

Validation: 457 native tests, 1,542 runtime tests (8 existing skips), 402 SSR
tests, and isolated Node ESM, edge ESM and CJS async contract probes pass.
Both frozen replay suites and 72 corpus/provenance/DOM/SSR oracle checks pass.
Real Chromium and HTTP
tests cover shell-first output, overlapping requests, minified client hydration,
DOM identity, refresh, rejection, unmount and disconnect cancellation. The browser
gate runs in root E2E CI/release validation. Runtime production/test typechecks,
Rust Clippy with all targets/features, API boundaries and compiler guardrails pass.

The [size archive](./benchmarks/async-ssr-hydration-size-2026-09-13.json) verifies
98 source-map entries and actual distributed inputs. Eager hydration adds 1,873 B
Brotli to complete ESM, 1,079 B to CJS, and 723 B to the Resource import with
shared Suspense support. Those budgets record the measured API cost. Selective
sync and async memo imports remain unchanged at 4,923 and 8,365 B. Application
and CPU qualification remain A8/G4/G5; no historical benchmark is relabeled.

## A3b: async keyed lists in parked DOM

Application qualification exposed an integration gap between keyed lists and
Suspense. The list waited for a connected parent before every diff. After a
pending read parked its parent, settlement returned before reading the source,
so the effect dropped its subscriptions and the resumed boundary stayed empty
or retained old rows.

A list still waits for its initial connection. Once its effect has started, its
live owner governs updates in a parked parent; disposal still stops subsequent
work. The regression covers initial pending and refresh, retained row/parent
identity, replacement and row cleanup, superseded completion, and disposal
before the last completion. Both cases fail on the preceding runtime and pass
with this change. The existing async/list checks pass (47 tests), as does the
runtime suite (1544 passed; eight existing opt-in/legacy cases skipped).
Production and test typechecks pass. This is correctness evidence, not a new
performance measurement. See the [recorded evidence](testing/async-keyed-list-evidence-2026-09-14.json).

## S2c: JSX consumer contracts

Application helpers can read reactive values through parameters, callbacks,
methods, aliases or imported functions. Their calls now retain a deferred JSX
consumer even when no direct reactive binding is visible at that call site.
These source spans are verified EmitIR consumer hints; they do not assert purity
or authorize memo elimination. Explicit `untrack` still defines snapshot reads.

Both DOM backends preserve numeric component props and children as values rather
than accidentally passing reactive functions. Authored callbacks keep their
identity, component keys evaluate once, and direct `await` expressions remain in
their original async scope. Conditional branches retain their own reads when the
condition's boolean is unchanged.

Validation: 42 native execution cases pass across disabled/safe/full optimization
and direct DOM/VNode output; the prior addon fails 36 of those cases. The complete
526-case native suite and 25 source-map/async-SSR checks pass. Review of all 3,172
frozen inputs finds 89 primary and 72 replay output changes, with unchanged
acceptance and diagnostics. 156 changes contain only getter/import differences;
5 additionally enable conditional branch tracking. The two Rust source-map
selectors and current corpus reference change while all frozen Babel output,
maps and authored source positions remain intact. See the
[review archive](./testing/jsx-consumer-contract-evidence-2026-09-14.json).

## A3c: readiness through equal derived values

A Resource key change can suspend an existing conditional before it reaches its
branch reads. Previously, recovery to the same boolean value suppressed the
consumer's next execution, restoring stale DOM without renewing its branch
subscriptions. Async failure-to-value recovery now counts as a graph change even
when ordinary value equality succeeds. Uninterrupted synchronous memo equality
continues to suppress redundant updates.

The Resource regression fails before the change and passes afterwards. Runtime
coverage separately exercises refreshing one async source and switching between
sources, subsequent value updates, retained component ownership and disposal.
Production application qualification is tracked separately by S5. See the
[evidence archive](./testing/async-memo-readiness-evidence-2026-09-14.json).

## S5: maintained strict application corpus

Eight maintained application fixtures now run through captured strict production
builds and executable browser/server flows. A library publisher and the strict
keyed benchmark compile fixture are reported separately. The gate records native
source/artifact identity, final compiler requests, diagnostics, app and package
hashes, source incidence and browser results; it rejects missing final transforms
and artifact drift. CI and release verification require the same command.

The dated run passes all 11 builds, five small application browser scenarios,
four real-app/SSR browser cases and streaming production smoke. Twelve application
source files contain two explicit snapshots across 2,693 lexical code lines
(0.743/K), or 1,776 function-body lines (1.126/K), plus two marked Resource getters.
Six advisory X003 warnings remain; no fallback or unsupported diagnostics pass
this gate. Seven contract tests verify counting and fail-closed capture behavior.

[The corpus report](./testing/strict-application-corpus.md) documents migrations,
regressions, reproducible commands, counting definitions and the
[dated artifact](./testing/strict-application-corpus-2026-09-14.json).
These are maintained fixtures, including an async-data/Webpack variant pair,
not independent external adoption evidence or a measured false-positive rate.
CPU and memory qualification remain G4/G5/A8.

## G3: unused scalar memos and retained SSA work

Implicit scalar memos with no authored or generated consumers are removed under
G1's closed state/write and initialization proof. Other declarators, explicit
memos and unproved calls/coercions/owners retain their behavior. The final graph
trace distinguishes elimination from inlining and confirms helper import removal.

DCE now reports the inline and trivial-Phi candidates it analyzed separately
from the corresponding rewrite counts, which remain zero. These observations
precede compaction and are not final remaining opportunities. General SSA plan
rewrites, recursive derived-chain elimination and global branch-aware lazy
placement remain retained work; HIR analysis alone does not establish a safe
source emission rewrite. The graph trace guide explains this boundary.

The new 27-case native gate passes, including mixed declarations, effect order,
cleanup, SSR and retained controls; the preceding addon fails only nine new
optimization/counter expectations. The complete 615-case native suite, both
frozen corpora (3,172 inputs), Clippy/fmt and 60 Rust guardrail tests pass.
Only three frozen outputs change, each by exactly one unused memo declaration
and its helper import. Full diagnostics, maps, metadata, artifacts, existing
explanations and previous core counters are unchanged. The original Babel
capture remains intact; only the current corpus reference is rebound.
See the [review archive](./testing/unused-scalar-memo-evidence-2026-09-14.json).
This is semantic and emitted-code evidence, without new CPU measurements.

## A8: executable application and migration model

The async-data example now places an owned `$async` computation beside its
Resource panels. A plain derivation feeds JSX, transitions account for input
changes, Suspense retains the note's DOM identity through refresh, and explicit
error/reset and hide/remount controls exercise recovery and cancellation.
README's async example uses the same model and executes successfully through
six native optimizer/DOM profiles, including SSR failure and request disposal.
The migration guide distinguishes current/stale reads, preparation/commit,
Resource cache policy, metadata compatibility and native-await/Preview boundaries.

The [application evidence](./testing/async-application-evidence-2026-09-14.json)
preserves the complete fresh strict corpus, source/tool/package hashes and logs.
All 11 build phases, five small-app flows, four real-app/SSR cases and streaming
smoke pass. Chromium 145.0.7632.6 verifies refresh identity, overlapping requests,
error recovery and disposal. The 13 application files contain two explicit
snapshots; the new panel adds none. Seven diagnostics are advisory, with no
fallback or unsupported diagnostics. This is maintained repository coverage,
not independent external adoption.

Distributed ESM/CJS package probes verify shared root/advanced graph behavior,
derivations, causal transitions, stale rejection, cancellation, cleanup and public
async declarations. They run in the existing runtime package gate. G4/G5 provide
separate current synchronous CPU/allocation/memory qualification: the five-framework
score is 1.113164 and the 1.10 target remains unmet. No zero-cost async or universal
optimal-graph claim is made from those results.

## Q1a: one native behavior suite for CI and release

The normal Node 22/24 CI job now invokes the canonical
`pnpm test:compiler:native-runtime` command. Its former copied list omitted
new async, factory/collection, JSX, graph-trace and unused-memo cases. Legacy
domain assertions now follow the actual root command and still require every
previously covered file. A new contract checks the added domains and the shared
release entry point.

Validation: all 621 native behavior cases, 31 compatibility/corpus contracts,
seven compiler CI/release scope tests and compiler typechecking pass. The new
contract uses ES2020-compatible array operations; the initial `Array.at` test
error was fixed without changing the project's target. The complete strict
application gate passes again. The [evidence](./testing/native-ci-suite-evidence-2026-09-14.json)
records the before/after coverage and source hashes. These are local checks of
the configured workflow, not a remote CI run.

## Q1b: preserve approved migration evidence

The A8 async migration section now lives in the separate
[async migration guide](./async-migration-guide.md), linked from README, the
async contract and the example. The legacy compiler migration guide is restored
byte-for-byte to the digest approved for the 0.31.0 removal decision. No historical
evidence, review identity, approval or integrity check is rewritten. A8's archived
source hashes remain historical; final qualification records the current paths.

The rollout-state gate and its 20 positive/adversarial tests pass with the original
approval chain. This resolves the migration-digest failure discovered by the
final `pnpm commit` preflight without weakening that gate.
