# Runtime performance and correctness checks

The runtime benchmark uses the native compiler and the current workspace runtime. It writes a separate `keyed/fict-local` entry in a local [js-framework-benchmark checkout](https://github.com/krausest/js-framework-benchmark), preserving any existing `keyed/fict` implementation and results.

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
