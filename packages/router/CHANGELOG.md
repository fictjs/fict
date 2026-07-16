# @fictjs/router

## 0.28.4

### Patch Changes

- @fictjs/runtime@0.31.0

## 0.28.3

### Patch Changes

- @fictjs/runtime@0.30.1

## 0.28.2

### Patch Changes

- @fictjs/runtime@0.30.0

## 0.28.1

### Patch Changes

- @fictjs/runtime@0.29.0

## 0.28.0

### Minor Changes

- Rank nested branches by their complete compiled pattern so a static route
  such as `/users/new` wins over an equally deep dynamic branch such as
  `/users/:id`.
- Make `Redirect from="..."` conditional on the current router-relative path,
  honor router bases, and prevent catch-all redirects from looping after they
  reach their target.
- Add `createResource(..., { suspense: true })`. Suspense mode throws a request
  token until the active load settles; non-Suspense mode returns `undefined`
  while loading. Refreshes clear current data while `latest()` retains the last
  successful value, including after a failed refresh.
- Follow both explicit `Location`/`X-Redirect` response headers and the final
  URL exposed after `fetch` follows a 302 or 303 form response. Same-origin
  destinations stay in the SPA router, while cross-origin destinations use a
  full-page navigation.
- Preserve the host's preceding `history.scrollRestoration` value. Disabled
  custom restoration no longer forces manual mode, and replacing or resetting
  an enabled manager restores the native setting it took over.

### Patch Changes

- Updated dependencies
- Updated dependencies [1d8200a]
- Updated dependencies [e870ecd]
- Updated dependencies [d5ad9eb]
  - @fictjs/runtime@0.28.0

## 0.27.0

### Minor Changes

- Publish the router with runtime 0.27 so routed trees receive the current
  ownership, resume, namespace, and deferred-rendering fixes.

### Patch Changes

- Match nested route branches deterministically, keep regular-expression
  filters reusable, reject malformed encoded params safely, enforce base-path
  segment boundaries, and replace stale match trees before rendering only the
  committed route result.
- Preserve programmatic navigation options, object targets, route-relative
  defaults, case-sensitive active links, hash and pop transitions, numeric
  history inputs, scroll state, and unindexed browser history rebasing.
  External links, downloads, reserved targets, and external hook targets remain
  under browser control.
- Resolve `Form` actions against the owning route, forward route params,
  encode action names, honor submitter overrides and index-route defaults, and
  serialize GET form entries with browser-compatible line breaks. Registered
  actions, route/path-relative basenames, external GET submissions, and
  `preventScrollReset` now retain their documented behavior.
- Track declarative, keyed, and GET fetcher submissions. Concurrent actions and
  retries settle independently, keyed replacements suppress stale completions,
  and fetcher leases and SSR submission stores are isolated per router
  instance.
- Isolate query caches per SSR request, include opaque arguments in cache
  identity, cache `undefined` results and failures, deduplicate refreshes,
  honor preload lifetimes, and avoid browser cleanup timers during SSR.
  Synchronous load/preload failures are contained, and route component props
  and preload state remain reactive.
- Dispose owned history listeners, route contexts, and before-leave handlers
  with their render roots. Navigation is blocked only by explicit prevention,
  and retry/proceed paths now settle safely.
- Remove the published bundle's undeclared optional `fict` runtime import.

- Updated dependencies:
  - @fictjs/runtime@0.27.0

## 0.26.0

### Minor Changes

- Publish router with runtime 0.26.0 so routed component trees receive the
  runtime cleanup, hydration/resume, store platform-object, and internal bundle
  fixes.
  - No router API behavior changed in this release.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.26.0

## 0.25.0

### Minor Changes

- Publish router with runtime 0.25.0.
  - No router API behavior changed in this release.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.25.0

## 0.24.0

### Minor Changes

- Publish router with runtime 0.24.0 so routed component trees pick up the
  child-binding untracking fix.
  - No router API behavior changed in this release.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.24.0

## 0.23.0

### Minor Changes

- Migrate router package builds from `tsup` to `tsdown` while preserving CJS/ESM
  outputs, declaration files, and JSX transform behavior.
  - Router output keeps the existing runtime dependency boundary and build-time
    handling for `import.meta` in CJS output.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.23.0

## 0.22.0

### Minor Changes

- Harden router components for strict compiler output and the 0.22 runtime train.
  - Route matches are updated through signals and accept materialized match
    objects.
  - Link/NavLink props avoid strict JSX diagnostics, bind computed props
    directly, and keep optional props typed precisely.
  - Route matching avoids `Array.prototype.at` so generated output stays
    compatible with the supported runtime targets.

### Patch Changes

- Updated dependencies [df4ed26]
  - @fictjs/runtime@0.22.0

## 0.21.0

### Minor Changes

- Keep router packaging aligned with the 0.21 runtime release train; no router API behavior changed in this release.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.21.0

## 0.20.0

### Minor Changes

- Keep router packaging aligned with the 0.20 runtime and SSR release train; no router API behavior changed in this release.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.20.0

## 0.19.0

### Minor Changes

- Keep router packaging aligned with the package metadata release train; no router API behavior changed in this release.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.19.0

## 0.18.0

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.18.0

## 0.17.1

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.17.1

## 0.17.0

### Minor Changes

- Align router with resumable event and hydration control-state runtime fixes.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.17.0

## 0.16.0

### Minor Changes

- Align router with map-key validation and analyzer tooling release updates.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.16.0

## 0.15.0

### Minor Changes

- Align router with runtime handler cleanup and dependency-walking fixes.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.15.0

## 0.14.0

### Minor Changes

- Align router with MCP security and runtime lint-cleanup release updates.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.14.0

## 0.13.0

### Minor Changes

- Align router with the MCP tooling release train.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.13.0

## 0.12.0

### Minor Changes

- Align router with strict-guarantee diagnostic fixes.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.12.0

## 0.11.0

### Minor Changes

- Align router with ownerDocument runtime fixes.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.11.0

## 0.10.0

### Minor Changes

- Align router with resumable-event, keyed-list, and state-write runtime/compiler fixes.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.10.0

## 0.9.0

### Minor Changes

- Align router with strict guarantee defaults and tracked branch patching fixes.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.9.0

## 0.8.0

### Minor Changes

- Align router with HIR fuzz and alias diagnostic compiler fixes.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.8.0

## 0.7.0

### Minor Changes

- Align router with runtime cleanup/performance and compiler metadata fixes.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.7.0

## 0.6.0

### Minor Changes

- Align router with control-flow and HIR compiler fixes.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.6.0

## 0.5.2

### Patch Changes

- Align router with SSR streaming and renderToPartial updates.
- Updated dependencies
  - @fictjs/runtime@0.5.2

## 0.5.1

### Patch Changes

- Fix router type surface.
- Updated dependencies
  - @fictjs/runtime@0.5.1

## 0.5.0

### Minor Changes

- Fix router behavior and add router test coverage and documentation.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.5.0

## 0.4.0

### Minor Changes

- Refresh router package metadata for release packaging.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.4.0

## 0.3.0

### Minor Changes

- Implement the core router and add route test coverage.

### Patch Changes

- Updated dependencies
  - fict@0.3.0
  - @fictjs/runtime@0.3.0

## 0.2.3

### Patch Changes

- Publish router with cross-module metadata release updates.

## 0.2.2

### Patch Changes

- Publish router with key narrowing and runtime store cache fixes.

## 0.2.1

### Patch Changes

- Publish router with HIR optimizer and macro fixes.

## 0.2.0

### Minor Changes

- Publish router with compiler/runtime integration and e2e coverage fixes.

## 0.1.0

### Minor Changes

- Publish router with initial runtime stability fixes.

## 0.0.15

### Patch Changes

- Initialize the router package.
