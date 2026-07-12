# @fictjs/playground

## Unreleased

### Patch Changes

- Isolate compiler diagnostics from ambient Babel configuration and scope
  compiler transforms to each session.
- Restrict preview filesystem access, reject untrusted Host headers, and require
  JSON media types for JSON mutation endpoints.
- Serialize session admission and disposal, drain in-flight requests before
  shutdown, retain timed-out verification jobs in the queue until they settle,
  and clean up failed preview swaps without port-reuse races.
- Clone template recommendations per request and preserve whether configuration
  profile overrides were explicit.
- Upgrade Babel and Vite to patched dependency releases.

## 0.9.0

### Minor Changes

- Fix compiler integration in playground verification flows.
- Implement full local playground workbench with session engine, diagnostics aggregation, share/import, and UI.
- Add full verification endpoint and verify panel (diagnostics + Vite build).
- Harden share payload limits and improve HTTP 400/404 error mapping.
- Add multi-tenant control plane: bearer auth, RBAC, tenant quotas, request metrics, and audit endpoints.
