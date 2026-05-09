# @fictjs/ssr

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
