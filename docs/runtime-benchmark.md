# Runtime performance and correctness checks

The runtime benchmark uses the native compiler and the current workspace runtime. It writes a separate `keyed/fict-local` entry in a local [js-framework-benchmark checkout](https://github.com/krausest/js-framework-benchmark), preserving any existing `keyed/fict` implementation and results.

## Recorded snapshot: 2026-09-12

The [README CPU table](../README.md#performance) compares initial runtime
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
- Fixture: [`main.tsx`](../scripts/fixtures/runtime-benchmark/main.tsx), compiled
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

### Reference workloads

The archived Solid 1.9.3 and vanilla CPU results come from an earlier batch in the
same audit, before the final runtime optimizations. For example, their 1,000-row
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

`perf:build` builds the native compiler, `@fictjs/runtime`, and `fict`; compiles the checked-in fixture; and bundles the actual package exports in production mode. No Babel preset or previously installed Fict dependency is used. `provenance.json` records the repository revision, runtime source diff, benchmark revision, compiler build identity, workspace lockfile digest, compiled application digest, and bundle/module digests.

`perf:check` requires the server to discover the requested entry. It runs 15 browser checks covering creation, replacement, repeated partial updates, selection, swapping, removal, append, and clear, including 11,000 rows. It compares all rows with a JavaScript model, checks retained DOM identities and removed nodes, and rejects browser exceptions. It runs separately from timing measurements.

Use named entries to preserve a baseline before making changes:

```sh
node scripts/runtime-benchmark-build.mjs --name fict-baseline
node scripts/runtime-benchmark-check.mjs --name fict-baseline
# After applying the runtime change:
node scripts/runtime-benchmark-build.mjs --name fict-candidate
node scripts/runtime-benchmark-check.mjs --name fict-candidate
```

Both scripts accept `--benchmark-root /absolute/path/to/js-framework-benchmark`. The check also accepts `--url http://localhost:8080` and `--chrome-binary /absolute/path/to/chrome`. The build accepts the existing `FICT_COMPILER_NATIVE_PATH` override.

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
