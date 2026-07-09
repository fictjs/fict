# SSR / Streaming / Resume Stability Contract

This contract defines supported behavior, Preview degradation expectations, and
non-goals for Fict SSR, streaming, hydration, and resumability. Stable guarantees
apply only to the supported `@fictjs/ssr` surface; Preview entries document
required failure behavior, not semver stability.

> **Maturity:** streaming patch, resumability, and partial prerendering are
> **Preview** — no semver guarantee yet. The required failure/degradation
> behavior is tracked in [PREVIEW.md](./PREVIEW.md); `@fictjs/ssr` is a Satellite
> package, see [SCOPE.md](../SCOPE.md).

## Scope

Covered:

- supported `@fictjs/ssr` rendering (`renderToString`, `renderToStream`, `renderToPipeableStream`)
- Preview `@fictjs/ssr/experimental` rendering (`renderToPartial`)
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
   - can hand rejected snapshots to an application-owned client render through
     `onSnapshotRejected`.

## Snapshot Compatibility Policy

Snapshot payload format:

```json
{
  "v": 2,
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
2. The current SSR writer emits schema v2. Missing `v`, v1, and every other
   non-v2 value fail closed with `snapshot_unsupported_version` unless the
   application provides a migration for that exact source version.
3. Invalid JSON / invalid shape are rejected with `snapshot_parse_error` /
   `snapshot_invalid_shape`.
4. Failed migrations are rejected with `snapshot_migration_failed`.
5. Rejected snapshots are never merged into active state.
6. The loader never guesses a legacy value codec. Historical v1 writers used
   two incompatible props encodings for the same bytes, so applications must
   select the writer family that produced their cached HTML.

Historical writer map:

| Deployed writer family         | Migration key                              | Required migration                               |
| ------------------------------ | ------------------------------------------ | ------------------------------------------------ |
| v0.5-v0.8, no `v`, raw props   | `UNVERSIONED_SNAPSHOT_MIGRATION_KEY` (`0`) | `createLegacySnapshotMigration('raw-props')`     |
| v0.9-v0.21, v1, raw props      | `1`                                        | `createLegacySnapshotMigration('raw-props')`     |
| v0.22-v0.26, v1, encoded props | `1`                                        | `createLegacySnapshotMigration('encoded-props')` |
| Current writer, v2             | None                                       | None                                             |

For example, a known v0.22-v0.26 deployment can opt in to its v1 dialect:

```ts
import { createLegacySnapshotMigration, installResumableLoader } from 'fict/loader'

installResumableLoader({
  snapshotMigrations: {
    1: createLegacySnapshotMigration('encoded-props'),
  },
})
```

An unversioned raw-props deployment must use the explicit sentinel rather than
silently treating missing `v` as v1:

```ts
import {
  UNVERSIONED_SNAPSHOT_MIGRATION_KEY,
  createLegacySnapshotMigration,
  installResumableLoader,
} from 'fict/loader'

installResumableLoader({
  snapshotMigrations: {
    [UNVERSIONED_SNAPSHOT_MIGRATION_KEY]: createLegacySnapshotMigration('raw-props'),
  },
})
```

Do not register a dialect merely because a payload has `v: 1`. Confirm the
deployed writer first: `{ "__t": "u" }` can mean either a literal object or an
encoded `undefined` value depending on that writer.

## Failure Semantics

Loader issue codes:

- `snapshot_parse_error`
- `snapshot_invalid_shape`
- `snapshot_unsupported_version`
- `snapshot_migration_failed`
- `snapshot_fallback_failed`
- `scope_snapshot_missing`
- `resume_import_failed`
- `resume_function_missing`
- `resume_failed`
- `handler_import_failed`
- `handler_missing`
- `handler_failed`

Operational behavior:

1. Loader does not crash on malformed snapshots; it reports and skips invalid
   payloads.
2. `onSnapshotIssue` is notification-only. It does not mount a client root.
3. When `onSnapshotRejected` is configured, parse, shape, version, migration,
   or missing-scope rejection disengages that document's loader before invoking
   the callback once. The application must mount its CSR root in the callback.
4. Without `onSnapshotRejected`, Fict does not mount CSR automatically. A
   missing-scope handler is skipped, while event-path scanning may continue to
   a valid ancestor scope.
5. `onSnapshotRejected` may be async. A thrown or rejected callback is reported
   as `snapshot_fallback_failed` through `onSnapshotIssue` without creating an
   unhandled promise rejection.
6. Resume and handler import/export/execution failures remain structured
   diagnostics; they do not imply CSR fallback or ErrorBoundary routing.

## Security Guidelines

1. Snapshot JSON must be script-safe escaped before embedding into HTML.
2. Never serialize secrets/tokens/PII into resumable snapshot state.
3. Prefer IDs and server fetch on interaction for sensitive or high-volume data.
4. Treat snapshot as client-visible data by design.
5. Strict CSP deployments should pass `scriptNonce`, or use `streamRuntime: 'external'` with observer patch mode and the published `@fictjs/ssr/fict-stream-runtime.js` asset to avoid per-chunk inline patch scripts.
6. Trusted Types deployments should prefer external observer mode. The streaming runtime avoids `innerHTML`/`eval`; host applications that require Trusted Types policies should apply them to the complete server-rendered HTML document rather than expecting Fict to create a browser-side policy.

## Streaming & Hydration Diagnostics

1. SSR tracking state, stream hooks, and boundary scope registries are isolated per render.
2. SSR does not expose DOM globals by default. `exposeGlobals: true` is a legacy compatibility mode for code that reads process-global `document/window`, and overlapping renders must not use it.
3. Web Streams and Node pipeable streams must respect downstream pull/drain backpressure before continuing queued chunks.
4. Hydration mismatches can be observed with `onHydrationIssue` and include node-missing, node-type, and text mismatch codes.
5. `strictHydration: true` turns mismatches into thrown errors after reporting the issue, for tests and deployments that prefer fail-fast hydration.
6. Mismatch diagnostics do not change the default fail-safe behavior: Fict still repairs or falls back to client-created nodes where needed.

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
3. Snapshot reject and CSR fallback rate by route, build ID, and schema version.
4. Snapshot byte size p50/p95 by route.
5. `snapshot_fallback_failed` count and error class.

## Release / Upgrade Guidance

1. Any snapshot schema bump (`v`) requires:
   - release note callout
   - compatibility statement (legacy accepted or not, and which `snapshotMigrations` are required)
   - regression tests for mixed/legacy payload behavior
   - application-owned fallback example
   - purge plan for cached SSR HTML, PPR/ISR output, KV/pre-rendered
     artifacts, and service-worker caches
2. SSR server bundle, HTML/snapshot, client loader, manifest, QRL chunks, and
   external stream runtime form one compatibility unit and must be deployed or
   rolled back as one build. See [SSR Deployment Guide](./ssr-deployment.md).
3. Major release can drop legacy support, but must document migration path and
   fallback plan.
4. SSR/resume release candidates must pass `pnpm test:ssr-matrix` and follow
   `docs/ssr-runtime-matrix.md`.
5. Tooling release candidates must pass `pnpm test:bundlers` and follow
   `docs/tooling-runtime-matrix.md`.
