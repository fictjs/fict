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
Internal tiers.

## What "Preview" means

- **No semver.** A Preview API may change shape or be removed in any release,
  including patch releases. It does not participate in
  [api-freeze-v1](./api-freeze-v1.md).
- **Not under the guarantee bar.** `strictGuarantee` and the
  [reactivity-guarantee-matrix](./reactivity-guarantee-matrix.md) do not promise
  anything about Preview behavior beyond "correctness-first, may be coarse."
- **Opt-in to reach.** Preview APIs are not exported from a package's main
  entrypoint.

## How Preview is marked (three required signals)

1. **`@experimental` JSDoc** on every Preview export, with a one-line reason and
   the closest stable alternative. Example:

   ```ts
   /**
    * @experimental Preview API for v1.0; the return shape may change before this
    * becomes stable. For stable streaming use `renderToPipeableStream`.
    */
   export function renderToPartial(/* … */) {}
   ```

2. **Reachable only via an `experimental` entrypoint**, never the main export:
   - Framework-level previews → `fict/experimental` (export subpath; see
     SCOPE.md migration step 3).
   - **Known current exception (Preview debt, not satisfied today):**
     `@fictjs/ssr`'s `renderToPartial` is still exported from the package's
     **main** entry. It carries the `@experimental` JSDoc, but it violates this
     principle right now. Tracked fix: add a `@fictjs/ssr/experimental` subpath
     and move it there. Until then this signal is aspirational for SSR.

3. **A `> **Preview**` callout** at the top of any doc page that teaches a
   Preview API.

## Current Preview surface

| API / capability                           | Host package                       | Why still Preview                                                                                                                                                           |
| ------------------------------------------ | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `renderToPartial` (partial prerendering)   | `@fictjs/ssr`                      | Return shape (`{ shell, stream, … }`) not frozen.                                                                                                                           |
| Resumable handlers / QRL extraction        | `@fictjs/compiler` + `@fictjs/ssr` | Not a stable Qwik-compatible contract.                                                                                                                                      |
| SSR snapshot schema (`data-fict-snapshot`) | `@fictjs/runtime`+ `@fictjs/ssr`   | A version field (`SSRState.v`) and a `snapshotMigrations` hook (runtime `loader.ts`) already exist; the cross-version **stability/migration commitment** is not yet frozen. |
| `fict/experimental` exports                | `fict`                             | Staging area; contents change freely.                                                                                                                                       |

## Graduation gate (Preview → Stable)

A Preview API may graduate only when **all** of the following hold. This is the
exit criterion that keeps Preview from becoming a permanent limbo.

- [ ] **Frozen shape**: inputs/outputs documented and covered by API-freeze.
- [ ] **Degradation contract** (below) implemented and tested.
- [ ] **Release-gate coverage**: the relevant rows of
      [ssr-runtime-matrix](./ssr-runtime-matrix.md) /
      [tooling-runtime-matrix](./tooling-runtime-matrix.md) pass — including
      CSP, stream abort, backpressure, and edge runtime where applicable.
- [ ] **Snapshot schema commitment frozen** (for resume/SSR): `v` field +
      `snapshotMigrations` already exist — freeze and document the
      migration/invalidation rule plus a back-compat window.
- [ ] At least one maintained example exercises the happy path **and** one
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

| Failure                                             | Required behavior                                                                                           | Default if unspecified |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------- |
| Snapshot missing / malformed JSON                   | Fall back to client render (CSR) for the affected root; emit a single dev warning; **never throw to user**. | Full CSR fallback      |
| Snapshot schema version mismatch (`v` newer/older)  | Invalidate snapshot; CSR fallback for affected scopes only; do not attempt partial deserialize.             | Full CSR fallback      |
| Scope id present in DOM but absent from snapshot    | Hydrate that scope from scratch (treat as fresh mount); keep sibling scopes resumed.                        | Per-scope re-init      |
| Scope deserializes but a slot value fails to revive | Invalidate **only that scope**; re-run it; log which slot/type failed.                                      | Per-scope invalidate   |
| DOM/snapshot structural mismatch during claim       | Stop claiming at the mismatch; mount fallback subtree; surface a `hydration` diagnostic.                    | Subtree remount        |
| QRL module fails to load on interaction             | Surface to nearest `ErrorBoundary`; if none, log and no-op the handler (do not crash the page).             | ErrorBoundary / no-op  |

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
- Snapshot-schema changes must include a fixture at the **old** version proving
  the mismatch path degrades, not crashes.
