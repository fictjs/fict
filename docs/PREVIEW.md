# Preview Surface Policy

> Some Fict capabilities are shipped **before** their contract is frozen. This
> document defines what "Preview" means, how Preview APIs are marked and
> reached, and — most importantly — the **degradation contract** every Preview
> feature must satisfy _before_ it can be recommended for production or graduate
> to stable.
>
> Preview is not "documented but unfinished." Preview is **"we have written down
> what happens when it fails."** Without a degradation contract, a feature is
> not Preview — it is just risk.

See [SCOPE.md](../SCOPE.md) for how Preview relates to Core / Satellite /
Internal tiers. For the current coverage of the degradation contract below
(what is implemented + tested vs. gaps), see
[preview-degradation-audit.md](./preview-degradation-audit.md).

## What "Preview" means

- **No semver.** A Preview API may change shape or be removed in any release,
  including patch releases. It does not participate in
  [api-freeze-v1](./api-freeze-v1.md).
- **Not under the guarantee bar.** `strictGuarantee` and the
  [reactivity-guarantee-matrix](./reactivity-guarantee-matrix.md) do not promise
  anything about Preview behavior beyond "correctness-first, may be coarse."
- **Opt-in to reach.** Preview callables are exported only from an
  `experimental` entrypoint. Cross-cutting Preview options on a supported host
  API are allowed only when tagged `@experimental`, default-off, and unable to
  emit or consume the Preview protocol unless explicitly enabled.

## Relationship to Core 1.0

Preview does not block Core 1.0. A Core 1.0 release may include Preview code,
but the Core compatibility promise, API freeze, and semver guarantee exclude
every surface registered as Preview in [maturity.json](../maturity.json).
Passing Preview degradation tests proves fail-safe behavior; it does not turn a
Preview capability into a stable Core promise.

## How Preview is marked (three required signals)

1. **`@experimental` JSDoc** on every Preview export and every default-off
   Preview option, with a one-line reason and the closest stable alternative.
   Example:

   ```ts
   /**
    * @experimental Preview API for v1.0; the return shape may change before this
    * becomes stable. For stable streaming use `renderToPipeableStream`.
    */
   export function renderToPartial(/* … */) {}
   ```

2. **Callable APIs are reachable only via an `experimental` entrypoint**, never
   a stable-looking export:
   - Framework resumability → `fict/experimental/loader`.
   - Low-level runtime resumability →
     `@fictjs/runtime/experimental/loader`.
   - **SSR previews** → `@fictjs/ssr/experimental` (`renderToPartial`).
     **Resolved:** `renderToPartial` is no longer on the `@fictjs/ssr` main
     export. The engine lives in the internal `render-core` module (not in
     `package.json#exports`); `.` re-exports only the supported surface, and
     `./experimental` re-exports the Preview surface.

   Cross-cutting opt-ins remain properties of their host configuration types:
   `FictCompilerOptions.resumable` and `RenderToStringOptions.includeSnapshot`.
   Both are tagged `@experimental`; both default to false. Resumable SSR must
   therefore say both `resumable: true` at compile time and
   `includeSnapshot: true` at render time.

3. **A `> **Preview**` callout** at the top of any doc page that teaches a
   Preview API.

## Current Preview surface

| API / capability                           | Host package                                       | Why still Preview                                                                                                                                    |
| ------------------------------------------ | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `renderToPartial` (partial prerendering)   | `@fictjs/ssr/experimental`                         | Return shape (`{ shell, stream, … }`) not frozen.                                                                                                    |
| Resumable handlers / QRL extraction        | compiler opt-in + `fict/experimental/loader`       | Generated ABI and loader API are not frozen.                                                                                                         |
| SSR snapshot schema (`data-fict-snapshot`) | SSR opt-in + `@fictjs/runtime/experimental/loader` | The v2 writer, explicit legacy migrations, and application-owned rejection callback exist; the long-term cross-version support window is not frozen. |

## Graduation gate (Preview → Stable)

A Preview API may graduate only when **all** of the following hold. This is the
exit criterion that keeps Preview from becoming a permanent limbo.

- [ ] **Frozen shape**: inputs/outputs documented and covered by API-freeze.
- [x] **Degradation contract** (below) implemented and tested.
- [ ] **Release-gate coverage**: the relevant rows of
      [ssr-runtime-matrix](./ssr-runtime-matrix.md) /
      [tooling-runtime-matrix](./tooling-runtime-matrix.md) pass — including
      CSP, stream abort, backpressure, and edge runtime where applicable.
- [ ] **Snapshot schema commitment frozen** (for resume/SSR): v2, explicit
      `snapshotMigrations`, and invalidation behavior are documented; a
      long-term back-compat support window still needs to be frozen.
- [x] At least one maintained example exercises the happy path **and** one
      failure path.

---

## Degradation contract (required for resume / streaming Preview)

The hard part of resumability and streaming is **not** the happy path — it is
what the running app does when the contract is violated in production. Every
Preview feature in this category must specify, in code and in tests, the
behavior for each failure below.

> Authoring note: copy this table into the feature's own doc/PR and fill every
> row. An empty row blocks graduation.

### Resume failure modes

| Failure                                                 | Required behavior                                                                                                                                                                                             | Default without an application callback                  |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Initial snapshot script is absent                       | Do not guess state. A later interaction whose scope is unavailable reports `scope_snapshot_missing`; applications that require eager CSR should detect the missing script before installing the loader.       | No eager error; affected resumable handler cannot run    |
| Snapshot JSON malformed / shape invalid                 | Reject without merging. Report one structured issue. If `onSnapshotRejected` exists, disengage the loader before invoking the application-owned CSR callback once. Never throw the parse failure to the user. | Report and keep the rejected payload out of active state |
| Snapshot schema version mismatches or migration fails   | Fail closed; never partially deserialize or infer a legacy codec. An explicit matching migration may accept a known writer. Otherwise use the same application-owned rejection path.                          | Report and keep the rejected payload out of active state |
| Scope id is present in DOM but absent from the snapshot | Report `scope_snapshot_missing`. With `onSnapshotRejected`, disengage and invoke the application's CSR callback. Without it, skip that handler; event-path scanning may continue to a valid ancestor scope.   | Skip the affected handler                                |
| Serialized scope state cannot be revived                | Report `snapshot_invalid_shape`; do not execute its handler. With `onSnapshotRejected`, use the application-owned CSR path.                                                                                   | Skip the affected handler                                |
| Resume module/export/function fails on interaction      | Emit `resume_import_failed`, `resume_function_missing`, or `resume_failed`; do not run the handler. Keep unrelated scopes usable. No ErrorBoundary routing or automatic CSR is promised.                      | Structured diagnostic and no-op                          |
| Handler module/export/function fails on interaction     | Emit `handler_import_failed`, `handler_missing`, or `handler_failed`; do not crash the page. No ErrorBoundary routing or automatic CSR is promised.                                                           | Structured diagnostic and no-op                          |
| DOM/snapshot structural mismatch during hydration claim | Stop claiming at the mismatch; mount the hydration fallback subtree; surface an `onHydrationIssue` diagnostic.                                                                                                | Subtree remount                                          |

`onSnapshotIssue` is telemetry-only. `onSnapshotRejected` is the explicit
application integration point for CSR: Fict removes the loader's listeners,
snapshot observer, prefetch work, and affected resumable state before calling
it. The callback may be async and is invoked once; callback failure is reported
as `snapshot_fallback_failed`.

### Streaming failure modes

| Failure                                       | Required behavior                                                                                  | Default if unspecified |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------- |
| Client disconnect / `signal` abort mid-stream | Abort server render promptly; run cleanups; reject `shellReady`/`allReady`; release backpressure.  | Abort + cleanup        |
| A Suspense boundary rejects after shell sent  | Route to nearest `ErrorBoundary` / `onError`; patch boundary with error UI; keep other boundaries. | Boundary error patch   |
| Backpressure: consumer slower than producer   | Honor `desiredSize`; suspend writes until `pull`; bounded buffer; never unbounded memory growth.   | Pause on backpressure  |
| Write throws after shell flushed              | Mark stream failed; abort; do not double-close the controller.                                     | Fail-fast abort        |
| CSP active (`scriptNonce`)                    | All injected `<script>` carry the nonce; `external` runtime mode available for strict CSP.         | Nonce on every script  |

### Test obligations

- Each row above is a test case, not a doc sentence. Prefer driving them through
  the existing `@fictjs/ssr` test harness and the runtime stress budgets
  (`pnpm guardrails:runtime`).
- Snapshot-schema changes must include fixtures for the **old** version proving
  default rejection, every supported explicit migration dialect, and the
  application-owned CSR path.
