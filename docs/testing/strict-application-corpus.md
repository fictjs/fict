# Strict application qualification

`pnpm test:strict-applications` builds the workspace and runs the maintained
application corpus with production strict guarantees. CI and the release gate
invoke the same command. `node scripts/strict-application-corpus.mjs --build-only`
is a partial diagnostic run; its report explicitly says the browser was not run.

The [2026-09-14 archive](./strict-application-corpus-2026-09-14.json) records eight
maintained application fixtures, one library publisher, and a separate keyed
benchmark compile fixture. The Webpack example is an async-data variant. This is
repository application evidence, not eight independent external migrations.

| Application     | Production build   | Executed behavior                                                    |
| --------------- | ------------------ | -------------------------------------------------------------------- |
| counter-basic   | Vite               | Events and numeric derived component props                           |
| counter-webpack | Webpack            | Resource key changes, rapid switching and refresh                    |
| todos           | Vite               | Add, trim, filter, same-key replacement, snapshots, delete and clear |
| forms           | Vite               | Deep store writes, live validation, submit and reset                 |
| async-data      | Vite               | Suspense lists, Resource key changes, stale completion and refresh   |
| real-apps       | Vite               | Task board, catalog, and dashboard browser scenarios                 |
| ssr-basic       | Vite client/server | Preview resumability and post-resume interaction                     |
| ssr-streaming   | Vite client/server | Production streaming smoke; its client entry is not a hydration test |

All 11 build phases pass. The five small application browser scenarios, four
real-app/SSR browser cases, and streaming smoke pass. Six `FICT-X003` advisory
warnings remain across the application builds; there are no fallback or
unsupported diagnostics. The publisher and strict keyed compile fixture have
no diagnostics. The keyed check does not measure CPU or establish browser parity.

## Source incidence

The application inputs contain 12 source files, 2,693 lexical code lines and
1,776 lines inside function bodies. They contain two explicit `untrack` snapshots:
**0.743 per thousand lexical code lines**, or **1.126 per thousand function-body
lines**. Both snapshots capture a todo row ID for an event. There are also two
explicit `reactive` getters for Resource arguments.

Lexical lines include types, JSX and styles. Function-body lines exclude
module-level style objects but include helpers and fetchers. Counts resolve
imported names, namespace members and direct immutable aliases by lexical symbol;
shadowed identifiers and unrelated functions do not count. Dynamic containers and
inferred wrappers are outside this metric. These numbers describe authored API
incidence, not runtime allocations, all possible unknown calls, a false-positive
rate, or the effort required to migrate an independent application.

## Repairs exercised by the corpus

- Forms now use `$store` for nested field writes and update that store on reset.
- Todos use an explicit array type for the filtered collection and explicit
  snapshot IDs where event closures retain a row value.
- Both async examples pass `reactive(() => props.userId)` to Resource. A plain
  argument is a value snapshot and does not become a subscription automatically.
- Compiler JSX consumers preserve helper reads, numeric props/children and
  callback identity through conditional VNode paths (S2c).
- Keyed lists remain subscribed while Suspense parks their live DOM (A3b).
- A suspended derived condition resumes even if its boolean equals its previous
  successful result, renewing the branch's Resource subscriptions (A3c).

The latter three were runtime/compiler defects discovered through application
execution. The corpus keeps those application flows in addition to their focused
regression tests.

## Evidence and maintenance

The runner verifies the native addon against its Rust build inputs and records
the native build ID, addon hash, package artifacts, lockfile, app source/config,
qualification scripts, final compiler requests, diagnostics and generated output
hashes. A transparent native observer records actual bundler calls. Fresh Vite
cache directories and observed final transforms prevent a warm cache from
substituting for strict compilation. Provisional metadata passes are recorded
separately and cannot substitute for a nonempty final transform.

Browser servers allow only captured assets and verify their hashes when served.
After execution, the runner checks that application source/config, assets,
workspace package artifacts, native addon and qualification scripts still match.
Reports and compiler journals go to `test-results/strict-application-corpus*` and
are uploaded by CI, including on failure. A successful local archive does not
assert remote CI completion.

Seven executable contract tests cover lexical counting, observer transparency,
strict option enforcement, source/build identity, and rejection of missing or
failed native transforms. Refresh the dated archive only after the complete gate
passes. Preserve its actual source/artifact identity and partial-run status;
never relabel an old archive as qualification of a later compiler.

Independent real-world adoption, new performance measurements, and the final
whole-stack release audit remain separate work.
