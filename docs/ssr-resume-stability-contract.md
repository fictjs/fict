# SSR / Streaming / Resume Stability Contract

This contract defines production guarantees and non-goals for Fict SSR, streaming, hydration, and resumability.

## Scope

Covered:

- `@fictjs/ssr` rendering (`renderToString`, `renderToStream`, `renderToPipeableStream`, `renderToPartial`)
- runtime resumable loader (`@fictjs/runtime/loader`)
- server snapshot payload emitted by SSR and consumed by loader

Out of scope:

- manual DOM mutation by app code / third-party libraries
- broken manifest deployment pipelines
- unsupported runtime environment behaviors outside documented APIs

## Behavior Contract

1. `renderToString` / `renderToDocument`:
   - produce deterministic SSR markup for the same input tree + props + environment.
   - include snapshot script by default (`includeSnapshot !== false`).
2. `renderToStream` shell mode:
   - emits shell first, then boundary patches in resolve order.
   - emits incremental `data-fict-snapshot` chunks for new scopes.
3. `renderToStream` all-ready mode:
   - emits full resolved HTML once all boundaries settle.
4. Loader:
   - parses initial snapshot and incremental snapshots.
   - resumes scopes lazily on first interaction.
   - reports snapshot/resume issues through `onSnapshotIssue`.

## Snapshot Compatibility Policy

Snapshot payload format:

```json
{
  "v": 1,
  "scopes": {
    "s1": {
      "id": "s1",
      "slots": [[0, "sig", 1]]
    }
  }
}
```

Policy:

1. `v` is the snapshot schema version (`FICT_SSR_SNAPSHOT_SCHEMA_VERSION`).
2. Missing `v` is treated as legacy v1 for backward compatibility.
3. Unsupported versions are rejected by loader with `snapshot_unsupported_version`.
4. Invalid JSON / invalid shape are rejected with `snapshot_parse_error` / `snapshot_invalid_shape`.
5. Older versions are accepted only when the loader receives an explicit `snapshotMigrations` entry for that version.
6. Failed migrations are rejected with `snapshot_migration_failed`.
7. Rejected snapshots are ignored (not merged into active state).

## Failure Semantics

Loader issue codes:

- `snapshot_parse_error`
- `snapshot_invalid_shape`
- `snapshot_unsupported_version`
- `snapshot_migration_failed`
- `scope_snapshot_missing`
- `resume_import_failed`
- `resume_function_missing`
- `resume_failed`
- `handler_import_failed`
- `handler_missing`
- `handler_failed`

Operational behavior:

1. Loader does not crash on malformed snapshots; it reports and skips invalid payloads.
2. If an event targets a scope without snapshot state, loader skips resumable handler execution for that event and reports `scope_snapshot_missing`.
3. Lazy resume/handler import failures are reported as structured issues and do not create unhandled promise rejections.
4. Teams should wire `onSnapshotIssue` to telemetry and fail-safe handling.

## Security Guidelines

1. Snapshot JSON must be script-safe escaped before embedding into HTML.
2. Never serialize secrets/tokens/PII into resumable snapshot state.
3. Prefer IDs and server fetch on interaction for sensitive or high-volume data.
4. Treat snapshot as client-visible data by design.
5. Strict CSP deployments should pass `scriptNonce`, or use `streamRuntime: 'external'` and observer patch mode to avoid per-chunk inline patch scripts.

## Streaming & Hydration Diagnostics

1. SSR tracking state, stream hooks, and boundary scope registries are isolated per render.
2. Web Streams and Node pipeable streams must respect downstream pull/drain backpressure before continuing queued chunks.
3. Hydration mismatches can be observed with `onHydrationIssue` and include node-missing, node-type, and text mismatch codes.
4. Mismatch diagnostics do not change the existing fail-safe behavior: Fict still repairs or falls back to client-created nodes where needed.

## Snapshot Size & Budget Guidance

Recommended initial budgets (adjust per product):

1. Initial snapshot script: warn at `> 30KB`, fail CI at `> 60KB` (gzip-independent raw bytes).
2. Incremental snapshot chunk: warn at `> 10KB` per chunk.
3. Total shell HTML + inline snapshot: keep under route-specific TTFB/SCW budget.

Suggested CI checks:

1. Parse built HTML and assert `#__FICT_SNAPSHOT__` byte size threshold.
2. Assert streaming chunk count/size for representative suspense routes.
3. Track historical trend and fail on sudden regression deltas.

## Observability Checklist

At minimum, capture:

1. Count of each loader issue code.
2. Resume success rate (interaction -> resumed scope -> handler executed).
3. Snapshot parse reject rate by route/build version.
4. Snapshot byte size p50/p95 by route.

## Release / Upgrade Guidance

1. Any snapshot schema bump (`v`) requires:
   - release note callout
   - compatibility statement (legacy accepted or not, and which `snapshotMigrations` are required)
   - regression tests for mixed/legacy payload behavior
2. Major release can drop legacy support, but must document migration path and fallback plan.
3. SSR/resume release candidates must pass `pnpm test:ssr-matrix` and follow `docs/ssr-runtime-matrix.md`.
