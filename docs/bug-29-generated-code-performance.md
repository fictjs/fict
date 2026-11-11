# Generated-code compiler regression: item 29

Measured on an Apple M1 Max, arm64 macOS 27.0.1, Node 24.16.0 and Rust 1.97.0. Both artifacts use the workspace release profile, the same default `transformSync` options, and the same generated TSX sources. The baseline is `efd0bc97f6dcc959492955462cf628e064a42630`, immediately before item 29; it includes the other 38 fixes. The candidate is this report's compiler change.

The inputs reproduce the shapes described in `bug.md`; both artifacts receive each fixture verbatim.

Each table entry is the median of three fresh Node child processes. Measurements exclude loading the addon, include the native request/result boundary, and retain normal compiler analysis for ordinary functions. No tests or builds ran concurrently with these samples. Machine timing is observational; these figures do not establish a universal speedup or linear complexity. Nested construct membership and accumulated dependency facts can still have quadratic output size.

| Input        | Size | Before (ms) | After (ms) | Before / after |
| ------------ | ---: | ----------: | ---------: | -------------: |
| `branches`   |  100 |       21.86 |       7.99 |           2.7× |
| `branches`   |  200 |      148.33 |      30.03 |           4.9× |
| `branches`   |  400 |     1151.00 |     132.67 |           8.7× |
| `branches`   | 1000 |    18292.29 |     932.67 |          19.6× |
| `switch`     |  100 |        6.69 |       2.82 |           2.4× |
| `switch`     |  200 |       32.69 |       5.61 |           5.8× |
| `switch`     |  400 |      222.54 |      20.40 |          10.9× |
| `sum`        |  100 |       22.59 |       3.49 |           6.5× |
| `sum`        |  200 |      158.27 |       6.87 |          23.1× |
| `sum`        |  400 |     1536.69 |      21.38 |          71.9× |
| `handler`    |  100 |       22.79 |      15.82 |           1.4× |
| `handler`    |  200 |      120.28 |      57.03 |           2.1× |
| `handler`    |  400 |      804.39 |     245.66 |           3.3× |
| `icons`      |  250 |      141.20 |      51.18 |           2.8× |
| `icons`      |  500 |      811.95 |     177.24 |           4.6× |
| `icons`      | 1000 |     5387.84 |     663.62 |           8.1× |
| `icons`      | 2000 |    50592.01 |    2627.14 |          19.3× |
| `components` |  250 |      275.20 |     124.25 |           2.2× |
| `components` |  500 |     1509.83 |     453.92 |           3.3× |
| `states`     |  250 |     1300.56 |      76.51 |          17.0× |
| `states`     |  500 |    12655.71 |     286.45 |          44.2× |
| `derived`    |  250 |       60.55 |      12.64 |           4.8× |
| `derived`    |  500 |      585.88 |      31.97 |          18.3× |

An additional 3,000-branch run completed in **8,810.57 ms** (three-sample median). Every generated branch returned its expected value after compilation. The old artifact was not rerun at this size; the larger baseline duration quoted in `bug.md` is not presented as a new measurement here.

The source generators are [checked in](../scripts/lib/native-generated-code-fixtures.mjs). `sum` repeats one state read; `states` declares distinct states, increments every one in a handler, and renders their sum. `derived` builds a chain of derived declarations. The complete samples, source sizes, diagnostics, process statuses and stage counters are in [the raw report](./bug-29-generated-code-results.json), with SHA-256 identities for the saved addons.

## Changes and correctness checks

- CFG dominator-tree intervals replace ancestry walks for each dominance query. Construct hierarchy selection checks the smallest possible owner first instead of testing all ancestor block sets.
- Dependency analysis propagates newly discovered facts to consumers. Reactive binding analysis revisits affected candidates in staged waves, preserving Alias/Derived precedence.
- Emit name allocation shares the immutable module name set and tracks allocated suffixes. The frontend indexes scope owners, function body intervals, source references and per-function evaluation facts once per module.
- Phase statistics now include frontend/HIR construction, metadata, lowering and codegen, exposing the former unmeasured work.

The native resource regression suite executes every branch in 800-arm `if` and `switch` functions, and mounts/clicks 300-term sums, 300-state components and 300-step derived chains. Existing HIR construction, dependency/CFG, compiler and native semantic suites qualify the indexed and worklist implementations. The pre-existing 128-level nullish dependency-graph test also passes on the default Rust test stack; the earlier version required a larger stack and took tens of seconds.

## Native stack containment

On the saved baseline, isolated transforms of 1,500 nested JSX elements, 4,000 parentheses and 5,000 objects all terminated with `SIGSEGV`. Larger probes (5,000 JSX / 10,000 parentheses / 10,000 objects) also crashed.

The candidate checks parsed AST depth with an iterative queue before semantic analysis and other recursive visitors. It returns `FICT-RESOURCE-LIMIT` with a location and help. Scoped 64 MiB compiler workers provide consistent stack space for the permitted tree shapes; N-API panic containment runs inside those workers. The regression suite covers synchronous and asynchronous transform, analyze and scan, then compiles another module in the same child process to verify recovery. This check follows OXC parsing and does not promise isolation from every possible native/parser fault.

## Reproduction

Save each release addon under a different `.node` filename, using a detached worktree at the baseline revision for the old artifact. On this macOS target the build product is `target/release/libfict_compiler_napi.dylib`; copy it to the `.node` filename after `cargo build --release -p fict-compiler-napi`.

```sh
node scripts/benchmark-native-generated-code.mjs --native /absolute/path/baseline.node --samples 3
node scripts/benchmark-native-generated-code.mjs --native /absolute/path/candidate.node --samples 3
FICT_COMPILER_NATIVE_PATH=/absolute/path/candidate.node node --test scripts/native-compiler-resource-regressions.test.mjs
```

Use `--case branches --sizes 1000,3000` to select larger dispatch tables, and `--timeout 60000` to set the per-child deadline. Failed processes and diagnostics produce a null median and a nonzero runner exit, rather than appearing as fast successful compilations.
