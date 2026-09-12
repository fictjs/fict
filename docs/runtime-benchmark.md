# Runtime performance and correctness checks

The runtime benchmark uses the native compiler and the current workspace runtime. It writes a separate `keyed/fict-local` entry in a local [js-framework-benchmark checkout](https://github.com/krausest/js-framework-benchmark), preserving any existing `keyed/fict` implementation and results.

## Implemented optimizations: 2026-09-13

The default fixture, compiler, and runtime now include the follow-up changes. The
[implementation archive](./benchmarks/runtime-implementation-2026-09-13.json)
records the complete five-framework CPU batches, all samples, frozen sources and
bundle hashes, exact workspace patches, and the strict unrounded 1.10 check.
The earlier 1.33 comparison and source experiments remain below as history.

### What is implemented

- The default fixture uses `createSelector`, per-row label signals with `batch`,
  `textContent`, and stable row captures with `untrack`. These use existing APIs
  and the same representation strategies as the recorded Solid implementation.
- The compiler marks template path resolutions that precede all dynamic
  bindings. Fresh templates use `firstChild` / `nextSibling` traversal;
  hydration still uses logical slot matching. This is an automatic compiler
  optimization for eligible templates, independent of the benchmark fixture.
- Fixed `textContent` bindings avoid a generic property dictionary. DOM property
  conversion, reactive getters, and repair after external DOM mutation remain
  covered by tests.
- Completed render effects release their ownership when they have no reactive
  dependencies, owned children, or cleanup. Effects with future work retain
  their lifetime and cleanup behavior.
- Keyed items allocate their tracking signal on the first tracked read. Stable
  untracked captures avoid an unused reactive node; later subscriptions and
  same-object updates still work.
- Root mount state lives on the root, cleanup uses fewer nested context
  wrappers, and unused deferred-ref state is not allocated during destruction.
- Keyed rows reuse successful DOM-brand validation. Clear uses one
  `replaceChildren` call when the list owns all container children, preserving
  its two marker nodes. Shared containers keep bounded range deletion.

The compiler does not automatically turn arbitrary row models into selectors,
per-row signals, or untracked captures. Those are explicit choices in the default
fixture. Arbitrary JSX getters retain their ownership path, and object
replacement under an existing key retains reactive item tracking. The prototype
that removed the row-ID effect at compile time and the prototype that fused
class/label effects were not adopted: their complete measured scores were worse.

### CPU results and the strict 1.10 check

The latest five-framework CPU geometric means are Vue Vapor **1.012232**, Solid **1.038705**, Svelte 5 **1.082474**, Fict **1.100919**, React Compiler **1.745426**.
The [README](../README.md#performance) lists every case mean. Each batch has 45
result records and 725 CPU samples; both complete batches remain in the archive.

| Qualification                                      | Same-batch geometric mean | Original fixed baseline | Strict ≤1.10, same batch / fixed |
| :------------------------------------------------- | ------------------------: | ----------------------: | :------------------------------- |
| First implemented candidate                        |                  1.108257 |                1.116030 | fail / fail                      |
| Final implementation, including lazy item tracking |                  1.100919 |                1.104012 | fail / fail                      |

The strict **≤1.10** check did **not** pass under either normalization. The comparison uses
the original numeric scores, not rounded display values. Fixed denominators make
the historical comparison independent of changes in reference-framework timing.
The combined fixture/compiler/runtime change reduces the fixed-baseline score by
**16.99%** from the original **1.329953**. These separate batches
do not isolate the contribution of each individual optimization.

Creation still has more JavaScript work than Solid, while browser rendering time
is much closer. These are means from the final qualification, in milliseconds:

| Operation              | Fict script | Solid script | Fict paint | Solid paint |
| :--------------------- | ----------: | -----------: | ---------: | ----------: |
| Create rows (1k)       |       8.727 |        3.613 |     26.247 |      26.100 |
| Create many rows (10k) |      67.167 |       33.707 |    287.407 |     287.800 |
| Clear rows (1k)        |      14.047 |       15.173 |      1.627 |       1.780 |

A separate five-page profile of the first implemented candidate partitioned clear
into **2.947 ms** before the DOM removal and **11.408 ms** in
`replaceChildren`, with 4× CPU throttling. Native DOM removal dominates that
handler. The diagnostic is archived separately and excluded from CPU scoring.
Further gains need measured reductions in binding/ownership creation and DOM
work; removing required getter ownership or cleanup semantics is not justified
by the remaining target gap.

### Page memory

A separate three-sample batch uses the harness's page-memory measurement after
forced GC. The source-only baseline and final implementation use the same
authored fixture; the original entry retains the original row model.

| Page memory (MiB)                   | Original fixture/runtime | Optimized fixture, old runtime | Final implementation |
| :---------------------------------- | -----------------------: | -----------------------------: | -------------------: |
| Ready                               |                    0.894 |                          0.903 |                0.905 |
| After creating 1k rows              |                    5.324 |                          5.090 |                4.440 |
| After creating and clearing 1k rows |                    1.411 |                          1.351 |                1.292 |

These are page-memory snapshots, rather than JavaScript-heap-only measurements.
Long-running ownership and disposal behavior is also checked by the separate
GC-enabled stress suite. Raw memory samples, commands, and build provenance are
included in the implementation archive.

### Correctness and reproducibility

The implementation passed 1,456 runtime tests, four separately enabled long
stress tests with exposed GC, 185 Fict tests, 402 SSR tests, 119 native compiler /
DOM / SSR / source-map tests, and 56 Rust OXC tests. Runtime source and test
typechecks, runtime ABI checks, package export and bundler smoke checks passed.
The frozen benchmark build passed 15 browser model checks through 11,000 rows
and official keyed creation, removal, and swap checks.

The measured implementation is an uncommitted workspace patch based on
`27dbe2d99e69341b64cc136a14d2829bc4d69fba`, still identifying as version 0.34.0.
Its provenance includes the runtime, compiler, fixture, and builder diffs.
Reference versions, production bundles, browser, harness revision, throttling,
and sample counts match the recorded comparison conditions below. Each complete
batch remeasures all five frameworks; CPU timing runs have no concurrent builds,
tests, profiles, or other benchmark runs. These results describe the local
implementation, not an npm release or an upstream benchmark submission.

## Framework comparison: 2026-09-12

This historical comparison records the five-framework CPU batch before the
fixture and compiler/runtime optimizations. Its table remains in the
[README performance history](../README.md#performance). The
[archived comparison data](./benchmarks/js-framework-benchmark-2026-09-12.json)
contains all 45 original result records, individual samples, source and bundle
hashes, dependency versions, the runner command, and aggregation details.

| Implementation | Version                                                                  |
| -------------- | ------------------------------------------------------------------------ |
| Vue Vapor      | 3.6.0-alpha.2                                                            |
| Solid          | 1.9.3                                                                    |
| Svelte         | 5.42.1                                                                   |
| Fict           | 0.34.0, runtime `b79c649481b672cf7580c25dcf4522942ccaf213`               |
| React Compiler | React / React DOM 19.0.0; compiler plugin `19.0.0-beta-37ed2a7-20241206` |

The harness revision is `c7c90491feb3f9be93177e3a7edd99707847da27`. Chrome
152.0.7977.83 ran headless on macOS arm64. There are 15 samples per CPU case,
except selection with 25. CPU slowdown is 4× for partial update, selection, swap,
and clear; 2× for removal; and disabled for creation, replacement, and append.
No builds, tests, profiles, or other timing runs ran concurrently.

The runner sorted entries as Fict, React Compiler, Solid, Svelte, and Vue Vapor
within each case. All five passed official keyed creation/removal/swap checks.
Reference entries use the harness source and locked dependencies, with production
builds in isolated directories. React's build enables the compiler plugin with
`compilationMode: "infer"`. Fict uses the same frozen native-compiled fixture and
bundle as the completed runtime audit; its bundle digest was checked over HTTP.

The CPU geometric mean assigns equal weight to the nine cases. For each case,
divide each implementation's mean total duration by the lowest mean among these
five, then take the geometric mean of those nine ratios. Memory and size are
excluded. The README rounds timings and ratios to two decimal places; the archive
retains the original precision and samples.

These are explicit local versions, rather than claims about the latest releases.
Each framework retains its own benchmark implementation: Fict uses immutable
`$state` row data and direct selected-row equality, while Solid uses per-row
signals and a selector. The comparison therefore measures the resulting compiled
applications, including representation and compiler differences. It is not an
isolated comparison of reactive primitives or a universal ranking.

## Source optimization experiments: 2026-09-12

A follow-up investigation held runtime `b79c6494` and the native compiler binary
constant while changing the benchmark source. The best complete nine-case result
was **1.128453**, a **15.15%** reduction in geometric-mean total duration against
the original five-framework comparison's fixed per-case denominators. A strict
**1.10** was not reached; it requires another **2.52%** reduction from this variant.

The [experiment archive](./benchmarks/runtime-optimization-2026-09-12.json) preserves
all 69 result groups and 1,025 CPU samples, source snapshots indexed by SHA-256,
compiler diagnostics, bundle/module hashes, operation counts, runner commands,
and both normalization calculations. Repository revision `27dbe2d9` contains only
documentation changes after the recorded runtime revision. Those runs changed only the benchmark source or generated-code prototypes.
The subsequent implementation adopts the source strategy and changes the compiler
and runtime; its results are recorded separately.

### Source changes and bottlenecks

The original fixture uses immutable arrays and string labels, direct selected-row
equality, and dynamic JSX text children. The optimized source uses the existing
`createSelector` API, per-row `createSignal` labels with `batch`, `textContent`
properties, and stable row objects captured with `untrack`. Solid's recorded
implementation uses the corresponding selector, signal, and text-property
strategies. React Compiler retains immutable row updates and a separate `Row`
component; its source strategy is closer to the original Fict fixture.

Separate instrumented builds confirmed the following counts for 1,000 rows:

| Operation                                         | Original fixture | Selector + textContent |
| ------------------------------------------------- | ---------------: | ---------------------: |
| Roots created during row creation                 |            3,000 |                  1,000 |
| Temporary roots immediately destroyed             |            2,000 |                      0 |
| Render effects created                            |            3,000 |                  3,000 |
| Comment nodes inside tbody                        |            2,002 |                      2 |
| Class binding evaluations when changing selection |            1,000 |                      2 |
| Per-text-node removal calls during clear          |            2,000 |                      0 |

Class evaluation counts are not counts of actual DOM writes; caches skip unchanged
values. The generic `insert` path creates an evaluation root to own work created
inside arbitrary getters, then destroys it when the result is primitive. This
ownership behavior must be preserved for general JSX. Instrumented bundles were
used only for operation counts, never for the CPU measurements.

Per-row label signals also avoid replacing the array and diffing the list during
partial updates. `textContent` alone did not improve that case's total duration
in the screening batch: lower script time coincided with higher paint time.
Click delegation, keyed updates, bulk clear via `Range.deleteContents`, and
omission of unused index signals were already present in the original runtime.

Stable row capture assumes that retained keys keep the same row object and labels
change through their signals. It does not preserve arbitrary same-key object
replacement semantics. The source snapshots are benchmark representations, not
an unconditional transformation for all application lists.

### Complete CPU results

Mean total durations are milliseconds, including rendering. The original column
comes from the earlier five-framework batch. The source variant, ID prototype,
Solid, and Vue Vapor were measured together in a later batch; fusion was measured
in a subsequent single-entry batch. Each has 15 samples per case, with 25 for
selection, using the same browser, production build settings, and CPU throttling.

| Case                                        | Original Fict | Source optimization | ID prototype | Fusion prototype |
| ------------------------------------------- | ------------: | ------------------: | -----------: | ---------------: |
| Create 1k                                   |        38.907 |              36.900 |       35.393 |           34.840 |
| Replace 1k                                  |        45.840 |              42.247 |       42.327 |           41.107 |
| Partial update                              |        22.793 |              19.327 |       20.087 |           20.220 |
| Select                                      |        12.604 |               6.044 |        6.740 |            6.496 |
| Swap                                        |        23.200 |              22.913 |       22.773 |           22.820 |
| Remove                                      |        17.680 |              17.520 |       17.400 |           17.693 |
| Create 10k                                  |       408.420 |             375.220 |      365.540 |          362.327 |
| Append 1k                                   |        45.020 |              41.647 |       41.847 |           41.200 |
| Clear                                       |        26.793 |              20.660 |       20.287 |           23.067 |
| **Geometric mean, original fixed baseline** |  **1.329953** |        **1.128453** | **1.135394** |     **1.141405** |

The source optimization scores **1.118710** if normalized instead against the
fastest means of the four entries in its own batch. This different denominator
must not be substituted into the original five-framework ranking. The archive
retains the fresh Solid and Vue Vapor samples as well as both calculations.

The ID prototype manually replaces the invariant ID binding with a one-time DOM
write. Fusion additionally groups the pure class and label setters in one existing
managed render effect per row. Both modify generated code; neither is a current
compiler feature. Neither established an aggregate improvement over the source
variant. Fusion increased clear time to 23.067 ms, and its specific allocation,
dependency-disposal, and GC contributions have not been isolated with a profile.

### Validation and remaining work

The initial screening batch contains six entries across four cases, with 10
samples per case and 20 for selection. Complete measurements add 36 result groups
for the four-entry batch and nine for fusion. Raw means, medians, standard
deviations, sample counts, and frozen bundle hashes were verified. Every measured
Fict variant passed 15 browser model checks, including 11,000 rows, and the
official keyed creation/removal/swap checks. Builds, behavior checks, and timing
measurements ran separately.

An excluded source variant used a callback-local row alias in its JSX key. That
form fell back from `createKeyedList` to generic insertion and failed retained DOM
identity checks. Keeping `key={item.id}` on the callback parameter preserved the
keyed path. No timing results from the failing variant contribute to these scores.

To reach 1.10 with the other eight cases unchanged, clear would need to fall from
20.660 ms to about **16.418 ms**; the remeasured Vue Vapor clear mean was 15.647 ms.
Alternatively, an equal **4.49%** reduction across creation, replacement, creation
of 10k rows, append, and clear would meet the same mathematical budget. These are
targets, not measured Fict improvements.

The follow-up implementation adopts the source changes, specializes compiler
template traversal, and reduces runtime binding and ownership costs. Arbitrary
JSX getters and keyed-object replacements still require their general paths;
the source transformation is not inferred unconditionally. General getter ownership, cleanup
ordering, error handling, and disposal reentrancy remain required semantics.
The experimental CPU scores do not qualify new compiler passes, memory behavior,
or a released implementation.

## Recorded snapshot: 2026-09-12

The [README runtime-audit details](../README.md#performance) compare initial runtime
`43ecf80abde2d8c01d29c0b72e393d66ffd75e8f` with final runtime
`b79c649481b672cf7580c25dcf4522942ccaf213`. Both identify as 0.34.0; the latter is
a local revision with the runtime audit fixes. This snapshot is not an npm or
upstream benchmark publication.

The [archived data](./benchmarks/runtime-2026-09-12.json) contains 52 original
result records with individual samples, summary statistics, source revisions,
and artifact digests. The two compiled application files have identical SHA-256
`9c515000e90780f00b684791f7b4dc674d7da7ea56c00d1b7e2b0594d7c25307`; the initial
provenance predates the compiled-digest field, so its frozen artifact was checked
directly. This holds compiler output constant for the runtime comparison.

### Conditions

- Harness revision: `c7c90491feb3f9be93177e3a7edd99707847da27`.
- Browser: Chrome 152.0.7977.83, headless, on macOS arm64; Node 24.16.0 and pnpm 9.1.1.
- Fixture: the original source, preserved in the
  [source experiment archive](./benchmarks/runtime-optimization-2026-09-12.json), compiled
  by the native Rust compiler with `dev: false` and `strictGuarantee: false`, then
  bundled in production mode targeting ES2022. The fixture uses immutable `$state`
  row data and direct selected-row equality.
- CPU slowdown: 4× for partial update, selection, swap, and clear; 2× for removal;
  no slowdown for creation, replacement, or append. Both runtime builds use the
  same factors. Durations include browser rendering.
- Main CPU batch: 15 samples per case, except selection with 25. No builds,
  tests, profiles, or other timing runs ran concurrently.
- Correctness: 15 browser model checks passed, including 11,000 rows, exact row
  contents, retained DOM identities, and disconnected removed rows. The official
  keyed creation/removal/swap checks also passed.

### Reversed-order repeat

Swap and clear were repeated with 30 samples per case. Separate invocations ran
the final runtime first, then the initial runtime. Mean durations are milliseconds.

| Case       | Initial total | Final total | Change | Initial JS | Final JS |
| ---------- | ------------: | ----------: | -----: | ---------: | -------: |
| Swap rows  |        22.657 |      22.860 | +0.90% |      2.153 |    2.550 |
| Clear rows |        26.807 |      25.963 | -3.15% |     23.217 |   22.593 |

Swap total increased 0.203 ms, with standard deviations of 0.744 ms initially and
0.828 ms finally. Its JavaScript mean increased 0.397 ms. Report the observed
variation alongside improvements; these samples do not establish that every
scenario became faster.

### Page memory

The harness forces garbage collection and reports
`performance.measureUserAgentSpecificMemory().bytes / 1024 / 1024`. These are
page-memory measurements in MiB, not just JavaScript heap or process RSS. Each
mean has three samples. Final runtime values were measured in a later batch than
the initial and reference values, using the same harness and browser.

| Case                  | Initial Fict | Final Fict | Change | Solid 1.9.3 |  Vanilla |
| --------------------- | -----------: | ---------: | -----: | ----------: | -------: |
| Ready                 |     0.889927 |   0.895792 | +0.66% |    0.593910 | 0.564170 |
| Create 1,000 rows     |     5.331215 |   5.319437 | -0.22% |    2.683196 | 1.873649 |
| Create and clear rows |     1.518092 |   1.408763 | -7.20% |    0.774947 | 0.646339 |

### Historical reference workloads

The fresh five-framework CPU comparison above supersedes these earlier CPU
reference measurements for README comparisons. The memory measurements in this
snapshot remain part of the original runtime audit.

The runtime-audit archive retains Solid 1.9.3 and vanilla CPU results from an
earlier batch in the same audit, before the final runtime optimizations. Their 1,000-row
creation means were 30.307 ms and 28.800 ms, compared with final Fict's 38.633 ms
in the later runtime comparison. These separate batches do not form a fresh
same-run final ranking.

The Solid reference is an isolated rebuild of the harness implementation with
locally installed Solid 1.9.3; vanilla is the tracked implementation from that
harness revision. Their source and artifact digests are archived with the data.
Solid uses per-row signals and a selector, while the Fict fixture uses immutable
row data and direct equality. Differences therefore include application
representation and compiler output as well as runtime costs. Creation and memory
gaps remain; this snapshot does not establish a universal fastest-framework claim.

## Setup and validation

Install the benchmark's server and webdriver dependencies using its README, and start its server on `localhost:8080`. Google Chrome must be installed. The default checkout path is `js-framework-benchmark/` at the Fict repository root.

```sh
pnpm perf:build
pnpm perf:check
pnpm perf:run
```

`perf:build` builds the native compiler, `@fictjs/runtime`, and `fict`; compiles the checked-in fixture; and bundles the actual package exports in production mode. No Babel preset or previously installed Fict dependency is used. `provenance.json` records the repository revision, runtime/compiler/fixture/builder diffs, benchmark revision, compiler build identity and options, workspace lockfile digest, source and compiled application digests, and bundle/module digests.

`perf:check` requires the server to discover the requested entry. It runs 15 browser checks covering creation, replacement, repeated partial updates, selection, swapping, removal, append, and clear, including 11,000 rows. It compares all rows with a JavaScript model, checks retained DOM identities and removed nodes, and rejects browser exceptions. It runs separately from timing measurements.

Use named entries to preserve a baseline before making changes:

```sh
node scripts/runtime-benchmark-build.mjs --name fict-baseline
node scripts/runtime-benchmark-check.mjs --name fict-baseline
# After applying the runtime change:
node scripts/runtime-benchmark-build.mjs --name fict-candidate
node scripts/runtime-benchmark-check.mjs --name fict-candidate
```

Both scripts accept `--benchmark-root /absolute/path/to/js-framework-benchmark`. The check also accepts `--url http://localhost:8080` and `--chrome-binary /absolute/path/to/chrome`. The build accepts `--source /absolute/path/to/main.tsx` for a separate source experiment, `--sourcemap` for profiling, and the existing `FICT_COMPILER_NATIVE_PATH` override. Preserve an immutable named entry for every published measurement.

## Measurement

Run the upstream keyed correctness check as well as the model check. From `js-framework-benchmark/webdriver-ts`:

```sh
node dist/isKeyed.js --framework keyed/fict-baseline keyed/fict-candidate --headless --browser chrome
node dist/benchmarkRunner.js --framework keyed/fict-baseline keyed/fict-candidate --benchmark 01_ 02_ 03_ 04_ 05_ 06_ 07_ 08_ 09_ --count 15 --headless
node dist/benchmarkRunner.js --framework keyed/fict-baseline keyed/fict-candidate --benchmark 21_ 22_ 25_ --count 3 --headless
```

Check that the runner lists both requested entries and produces the expected results. Some upstream runner versions exit successfully when no framework matches. Smoke runs validate operations but do not write performance results.

Keep browser version, harness revision, fixture, compiler options, CPU throttling, and sample counts identical. Confirm the compiled application digests match for a runtime-only comparison. Do not run builds, tests, or other benchmarks concurrently with timing runs. Keep raw results and provenance together; repeat close or inconsistent comparisons in alternating order before drawing conclusions. Some harness versions sort frameworks independently of their command-line order; separate single-framework invocations can control the order. Preserve each run's files before the next invocation overwrites them.

The benchmark measures table operations and includes browser rendering. Its CPU, memory, and size results complement the runtime tests, GC-enabled stress checks, packaged entrypoint tests, and application/browser integration tests. A result for a particular checkout and browser does not establish a universal framework ranking or prove absence of runtime defects.
