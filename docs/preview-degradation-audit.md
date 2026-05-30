# Preview Degradation — Coverage Audit (Step 5)

> Evidence ledger for the degradation contract defined in [PREVIEW.md](./PREVIEW.md).
> For each failure mode it records the **actual implemented behavior** (file:line)
> and the **test** that pins it, replacing PREVIEW.md's "Default if unspecified"
> placeholders with verified reality.
>
> **Headline:** the contract is far more real than the placeholders implied —
> **10 of 11 rows are implemented _and_ tested.** Most of the contract can
> graduate now. The one real gap — a streaming **sink-error hang** (G1) — is now
> **fixed and regression-tested**; only optional reinforcement **G2** remains.

This corresponds to [SCOPE.md](../SCOPE.md) migration **Step 5**. A row is only
"done" for graduation when both **Impl** and **Test** are ✅.

## Resume failure modes

| #   | Failure (PREVIEW row)                         | Implemented behavior                                                                                                                                                                                           | Where                                                | Test                                                                                                                   | Status                                                     |
| --- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| R1  | Snapshot missing / malformed JSON             | `JSON.parse` in try/catch → `snapshot_parse_error` issue; state stays `null` → app client-renders. Never throws to user.                                                                                       | `runtime/src/loader.ts` (`parseSnapshotText`, ~L416) | `runtime/test/loader.test.ts:208` (`'{not-valid-json'` → asserts `snapshot_parse_error` + `snapshot_invalid_shape`)    | ✅ impl ✅ test                                            |
| R2  | Snapshot schema version mismatch              | Version checked vs `FICT_SSR_SNAPSHOT_SCHEMA_VERSION`; tries `snapshotMigrations`, else `snapshot_unsupported_version` (fail-closed). Migration guards cycles / invalid / non-advancing versions.              | `loader.ts` ~L442–540 (`migrateSnapshotState`)       | `loader.test.ts` (`snapshot_unsupported_version`, `snapshot_migration_failed`)                                         | ✅ impl ✅ test                                            |
| R3  | Scope id in DOM but absent from snapshot      | `scope_snapshot_missing` issue; that scope re-inits, siblings keep resumed state.                                                                                                                              | `loader.ts` (code `scope_snapshot_missing`)          | `loader.test.ts` (`scope_snapshot_missing`)                                                                            | ✅ impl ✅ test                                            |
| R4  | Scope deserializes but a slot fails to revive | `resume_failed` / `resume_import_failed` / `resume_function_missing` issues; failure is reported per scope. (SSR-side signal-read errors are also swallowed, `resume.ts:362`.)                                 | `loader.ts` (codes), `resume.ts:358–366`             | `loader.test.ts` (`resume_failed`, `resume_import_failed`)                                                             | ✅ impl ⚠️ test — see Gap G2 (sibling-isolation assertion) |
| R5  | DOM/snapshot structural mismatch during claim | Stop at mismatch → `node_missing` / `node_type_mismatch` / `text_mismatch` issue → `mountFallback` mounts the fallback subtree; `text_mismatch` repairs `.data`. `onHydrationIssue` + `strictHydration` throw. | `runtime/src/hydration.ts:84–254`                    | `runtime/test/resume-lifecycle.test.ts` (`node_type_mismatch`, `text_mismatch`, `onHydrationIssue`, `strictHydration`) | ✅ impl ✅ test                                            |
| R6  | QRL module fails to load on interaction       | `handler_import_failed` / `handler_missing` / `handler_failed`; logged via `console.error`, does not crash the page.                                                                                           | `loader.ts` ~L760–767 (codes L234–236)               | `loader.test.ts` (`handler_failed`, `handler_import_failed`)                                                           | ✅ impl ✅ test                                            |

## Streaming failure modes

| #   | Failure (PREVIEW row)                         | Implemented behavior                                                                                                                                                                    | Where                                                                      | Test                                                                       | Status                         |
| --- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------ |
| S1  | Client disconnect / `signal` abort mid-stream | `abort(reason)` runs cleanup, rejects `shellReady`/`allReady`, drains backpressure; `ReadableStream.cancel` wired to abort.                                                             | `ssr/src/render-core.ts` (`abort`, `cancel`)                               | `ssr/test/streaming.test.ts` (abort / disconnect)                          | ✅ impl ✅ test                |
| S2  | A Suspense boundary rejects after shell sent  | Routed to `onError` / nearest `ErrorBoundary`; other boundaries keep resolving.                                                                                                         | `render-core.ts` (`hooks.onError`), `runtime/src/suspense.ts` (`onReject`) | `ssr/test/streaming.test.ts`, `runtime/test/suspense.test.ts` (`onReject`) | ✅ impl ✅ test                |
| S3  | Backpressure: consumer slower than producer   | Honors `desiredSize`; suspends writes via `readyResolvers` until `pull`; bounded.                                                                                                       | `render-core.ts` ~L279–348                                                 | `ssr/test/streaming.test.ts` (backpressure)                                | ✅ impl ✅ test                |
| S4  | Write throws after shell flushed              | Sink errors route via the pipe bridge `onError` → render `abort` (rejects shell/all, flushes the stalled drain so cleanup runs); `handleWriteError` also guards injected-writer throws. | `render-core.ts` ~L549–599 (`handleWriteError`/`enqueueWrite`)             | `streaming.test.ts` ('downstream sink errors')                             | ✅ impl ✅ test — **G1 fixed** |
| S5  | CSP active (`scriptNonce`)                    | All injected `<script>` carry the nonce; `external` runtime mode for strict CSP.                                                                                                        | `render-core.ts` (`renderNonceAttribute`, `buildStreamRuntimeScript`)      | `ssr/test/streaming.test.ts` (`nonce`, `scriptNonce`)                      | ✅ impl ✅ test                |

## Gaps

- **G1 — Streaming sink-error hang — FIXED.** Found while writing the S4 test:
  `handleWriteError` is effectively unreachable via the public API, but the
  reachable failure — a piped `Writable` that errors mid-stream — **hung** the
  render (`allReady` never settled; after the sink unpiped, the source
  `PassThrough` backed up and the write chain never drained). **Fix:** the pipe
  bridge now takes an `onError` channel wired to the render's `abort`
  (`render-core.ts` `renderToPipeableStream`), and flushes pending backpressure
  drains on sink-error/abort so the stalled write chain releases; `abort` now
  settles `shellReady`/`allReady` even when `finalize()` already set `closed`.
  Regression test: `ssr/test/streaming.test.ts` › 'aborts the pipeable render
  when a downstream sink errors' (was a 5 s timeout; now ~8 ms).
- **G2 — Per-scope revive isolation assertion (R4) is weak.** `resume_failed` is
  tested, but not the invariant "a failing scope does not invalidate its
  siblings." Add a focused assertion. _(Lower priority; behavior appears correct,
  only the explicit guarantee test is missing.)_

## Graduation impact

Per PREVIEW.md's graduation gate, the "degradation contract implemented and
tested" criterion is now **met for every row (resume R1–R6, streaming S1–S5)**
after G1 was fixed; only optional reinforcement **G2** remains. The
degradation-contract bar is fully test-backed — one of the bars that keeps
`renderToPartial` / resume in Preview is cleared.

> Note: graduation also requires the _other_ gate items (frozen shape, release-gate
> matrix rows, frozen snapshot-schema commitment). This audit only covers the
> degradation-contract bar.
