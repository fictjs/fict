# @fictjs/ssr

## 0.28.1

### Patch Changes

- @fictjs/runtime@0.29.0

## 0.28.0

### Breaking Changes

- **Preview resumability:** snapshots are now opt-in. Pass
  `includeSnapshot: true`, compile with `resumable: true`, and install the
  loader from `fict/experimental/loader` or
  `@fictjs/runtime/experimental/loader`. Resumability, snapshot schema v2, and
  partial prerendering remain Preview and outside the Core 1.0 semver promise;
  supported string and streaming SSR no longer emit Preview state by default.

### Minor Changes

- Make legacy `exposeGlobals: true` rendering exclusive from every other SSR
  render, including across loaded package copies. Global descriptors are
  installed and restored transactionally without invoking accessors; ordinary
  render-local SSR still works on a non-extensible process global, while
  compatibility mode fails closed there.
- Reject nonce-free external-runtime shell streams that place incremental
  Preview snapshots in `head`, where an executable mover is required. Strict
  CSP deployments can use `container`/`body` placement or provide a nonce.

### Patch Changes

- Keep overlapping hyphen runs inside serialized comments inert so values such
  as `--->` cannot expose following markup when browser-parsed.
- Serialize reactive HTML selects with browser-compatible first-match,
  unmatched-value, and DOM string semantics, including on server DOMs whose
  `select.value` getter is read-only or whose duplicate selection behavior is
  non-conforming.
- Updated dependencies
- Updated dependencies [1d8200a]
- Updated dependencies [e870ecd]
- Updated dependencies [d5ad9eb]
  - @fictjs/runtime@0.28.0

## 0.27.0

### Breaking Changes

- **Preview — resumable SSR snapshots:** SSR output now writes schema v2. The
  matching client loader rejects missing-version and v1 snapshots by default.
  - Treat the SSR server, cached HTML/PPR/ISR output, client loader, manifest,
    QRL chunks, service-worker document caches, and external stream runtime as
    one build for deploy and rollback, and purge derived documents when
    switching versions.
  - If legacy output must remain, configure the exact migration selected from
    deployment history: `raw-props` for unversioned/v1 writers through v0.21,
    or `encoded-props` for v1 writers from v0.22 through v0.26. Payload shape
    cannot distinguish the formats safely.
  - Use `onSnapshotRejected` for the application-owned CSR fallback after the
    loader disengages.

### Minor Changes

- Escape and validate HTML according to text, attribute, raw-text, script,
  comment, processing-instruction, doctype, and DOM-name context. Void elements,
  plaintext/raw-text hosts, parser-sensitive resumable hosts, and final DOM
  serialization now fail safely instead of producing ambiguous markup.
- Preserve qualified namespace prefixes and HTML/SVG/MathML foreign-content
  transitions in both complete and streamed output, including template content
  and explicitly closed namespaced nodes.
- Wait for asynchronous render work, retain request sessions across async
  continuations, and make CommonJS abort, writer failure, readiness, application
  error callbacks, and cleanup deterministic even when another cleanup path
  throws.
- Split streaming documents only at parser-safe structural boundaries. Patch
  identities are isolated per stream, existing stream runtimes upgrade safely,
  handled Suspense failures settle, and abandoned boundaries no longer retain
  work.
- Scope initial and incremental snapshots to visible patches, refresh scopes
  before emission, preserve nested and dynamic component state, and isolate
  resumable scope identities across renders and concurrent streams.
- Supported SSR API signatures are unchanged.

### Patch Changes

- Updated dependencies:
  - @fictjs/runtime@0.27.0

## 0.26.0

### Minor Changes

- Publish SSR with runtime 0.26.0 so server-rendered and hydrated trees stay
  aligned with the runtime cleanup, hydration/resume validation, loader
  boundary, and SSR session fixes.
  - No SSR API behavior changed in this release.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.26.0

## 0.25.0

### Minor Changes

- Publish SSR with runtime 0.25.0.
  - No SSR API behavior changed in this release.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.25.0

## 0.24.0

### Minor Changes

- Publish SSR with runtime 0.24.0 so server-rendered component trees stay aligned
  with the child-binding untracking fix.
  - No SSR API behavior changed in this release.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.24.0

## 0.23.0

### Minor Changes

- Migrate SSR package builds from `tsup` to `tsdown` while preserving the main,
  experimental, and stream-runtime entrypoints.
  - The publish build still writes the standalone `fict-stream-runtime.js`
    runtime asset after bundling.
  - Development watch mode now uses tsdown's `--on-success` hook to refresh the
    stream runtime asset.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.23.0

## 0.22.0

### Minor Changes

- 235e589: Move the Preview `renderToPartial` API off the `@fictjs/ssr` main export to a
  dedicated `@fictjs/ssr/experimental` entrypoint.
  - Import it from `@fictjs/ssr/experimental` instead of `@fictjs/ssr`.
  - The supported surface — `renderToString`, `renderToStringAsync`,
    `renderToStream`, `renderToPipeableStream`, `renderToDocument`,
    `createSSRDocument` — is unchanged.

  This aligns SSR with the Preview policy (`docs/PREVIEW.md`): Preview APIs are
  reachable only via an `experimental` entrypoint, never a package's main export.
  The implementation moved to an internal `render-core` module that is not part of
  `package.json#exports`.

### Patch Changes

- 699ccae: Fix pipeable SSR streams so downstream writable errors abort the render instead
  of hanging `allReady`.

  When a piped Node writable fails after the shell has flushed, Fict now routes the
  sink error into the render abort path, releases pending backpressure waits, runs
  cleanup, and rejects readiness promises deterministically.

- Updated dependencies [df4ed26]
  - @fictjs/runtime@0.22.0

## 0.21.0

### Minor Changes

- Make DOM globals opt-in, scope manifests to individual render sessions, and harden resumable and streaming coverage for Trusted Types and partial renders.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.21.0

## 0.20.0

### Minor Changes

- Add CSP-safe stream scripts, stream runtime assets, resumable state isolation, backpressure handling, and abort/cancel coverage.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.20.0

## 0.19.0

### Minor Changes

- Publish SSR with the library metadata release train; no SSR runtime behavior changed in this release.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.19.0

## 0.18.0

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.18.0

## 0.17.1

### Patch Changes

- Fix standard `fict` app installs so compiler-generated helpers resolve through `fict/internal` and `fict/loader` instead of requiring a separate top-level `@fictjs/runtime` install. This also adds the new `fict/internal`, `fict/internal/list`, and `fict/loader` bridge entrypoints and updates docs/examples to use the main `fict` package consistently.
- Updated dependencies
  - @fictjs/runtime@0.17.1

## 0.17.0

### Minor Changes

- Publish SSR with resumable handler and hydration control-state runtime fixes.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.17.0

## 0.16.0

### Minor Changes

- Publish SSR with map-key validation and tooling analysis updates; no SSR behavior changed.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.16.0

## 0.15.0

### Minor Changes

- Split stream/global helpers and pick up runtime SSR tracking reset behavior.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.15.0

## 0.14.0

### Minor Changes

- Publish SSR with MCP security and parse-diagnostic release updates; no SSR behavior changed.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.14.0

## 0.13.0

### Minor Changes

- Publish SSR with the MCP tooling release train; no SSR behavior changed.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.13.0

## 0.12.0

### Minor Changes

- Publish SSR with strict-guarantee fixture updates; no SSR behavior changed.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.12.0

## 0.11.0

### Minor Changes

- Publish SSR with ownerDocument runtime fixes used by hydrated output.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.11.0

## 0.10.0

### Minor Changes

- Publish SSR with resumable-event and state-write runtime/compiler fixes.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.10.0

## 0.9.0

### Minor Changes

- Harden snapshot resume contract and loader validation.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.9.0

## 0.8.0

### Minor Changes

- Publish SSR with strict guarantee defaults and branch tracking fixes.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.8.0

## 0.7.0

### Minor Changes

- Publish SSR with runtime cleanup/performance and compiler metadata cache fixes.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.7.0

## 0.6.0

### Minor Changes

- Publish SSR with compiler control-flow and HIR compatibility fixes.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.6.0

## 0.5.2

### Patch Changes

- Implement streaming SSR, renderToPartial, file manifests, node backpressure, edge smoke coverage, and preview docs.
- Updated dependencies
  - @fictjs/runtime@0.5.2

## 0.5.1

### Patch Changes

- Publish SSR with effect cleanup and ShadowRoot list fixes; no SSR API changed.
- Updated dependencies
  - @fictjs/runtime@0.5.1

## 0.5.0

### Minor Changes

- Implement core SSR, hydrateComponent, resumable signal names, and SSR event test stability.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.5.0

## 0.4.0

### Minor Changes

- Refresh SSR package metadata for release packaging.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.4.0

## 0.3.0

### Minor Changes

- Publish SSR with reactive behavior, router, testing-library, devtools, and Vite metadata updates from the release train.

## 0.2.3

### Patch Changes

- Publish SSR with cross-module reactive metadata and dynamic key narrowing fixes.

## 0.2.2

### Patch Changes

- Publish SSR with key narrowing, transform cache, literal support, destructuring assignments, and store cache fixes.

## 0.2.1

### Patch Changes

- Publish SSR with the HIR optimizer, `@fictReturn`, and macro state and memo fixes.

## 0.2.0

### Minor Changes

- Publish SSR with compiler/runtime integration, suspension handling, sourcemap, and e2e coverage fixes.

## 0.1.0

### Minor Changes

- Publish SSR with DOM binding, lifecycle, createRoot inheritance, and runtime stability fixes.

## 0.0.15

### Patch Changes

- Publish SSR with props API fixes and initial router package scaffolding.

## 0.0.14

### Patch Changes

- Publish SSR with delegated event, prop API, signal export, and state refactors.

## 0.0.13

### Patch Changes

- Publish SSR with SSA/destructuring, unkeyed list rendering, and dev-mode size fixes.

## 0.0.12

### Patch Changes

- Publish SSR with runtime ESM key, disposal, reorder, and package metadata fixes.

## 0.0.11

### Patch Changes

- Publish SSR with event handler invocation and effect cleanup fixes.

## 0.0.10

### Patch Changes

- Publish SSR with early integration and performance fixes.

## 0.0.9

### Patch Changes

- Publish SSR with sourcemap, host root, SVG, and list rendering fixes.

## 0.0.8

### Patch Changes

- Publish SSR with reactivity semantics, `$state`, hooks, and store dependency fixes.

## 0.0.7

### Patch Changes

- Fix SSR package configuration for published package resolution.

## 0.0.6

### Patch Changes

- Align SSR package configuration and version metadata for the release.

## 0.0.5

### Patch Changes

- Fix compiler hoisted-function handling.

## 0.0.4

### Patch Changes

- Fix runtime event handler behavior.
- Fix compiler accessor handling.
