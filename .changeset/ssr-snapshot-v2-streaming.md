---
'@fictjs/ssr': minor
---

### Breaking Changes

**Preview — resumable SSR snapshots:** SSR output now writes snapshot schema v2.
The matching client loader rejects missing-version and v1 snapshots by default,
so HTML, PPR/ISR artifacts, service-worker document caches, the SSR server,
client loader, manifest, QRL chunks, and external stream runtime must be
deployed and rolled back as one compatibility unit.

If cached output cannot be purged immediately, configure the client loader with
the explicit migration matching the deployed writer: `raw-props` for
unversioned/v1 output through v0.21, or `encoded-props` for v1 output from v0.22
through v0.26. The format cannot be inferred safely from the snapshot bytes.
Use `onSnapshotRejected` for the application-owned CSR fallback.

SSR rendering now escapes and validates HTML according to text, attribute,
raw-text, script, and DOM-name contexts; waits for asynchronous render work
before completing; prevents Suspense materialization from self-notifying its
parent render effect; and makes CommonJS pipeable-stream abort paths settle
deterministically. Supported SSR API signatures are unchanged.
