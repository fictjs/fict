# @fictjs/vite-plugin

## 0.25.0

### Minor Changes

- Publish the Vite plugin with compiler 0.25.0 so Vite builds pick up the
  codegen context and hook return accessor fixes.
  - No Vite plugin API behavior changed in this release.

### Patch Changes

- Updated dependencies
  - @fictjs/compiler@0.25.0

## 0.24.0

### Minor Changes

- Publish the Vite plugin with compiler 0.24.0.
  - No Vite plugin API behavior changed in this release.

### Patch Changes

- Updated dependencies
  - @fictjs/compiler@0.24.0

## 0.23.0

### Minor Changes

- Migrate the Vite plugin build from `tsup` to `tsdown` while preserving
  CJS/ESM outputs, declaration files, sourcemaps, compiler externalization, and
  package metadata support.

### Patch Changes

- Updated dependencies
  - @fictjs/compiler@0.23.0

## 0.22.0

### Minor Changes

- Include strict-guarantee environment flags in transform cache keys and publish
  the Vite plugin with compiler 0.22 so strict and non-strict builds cannot reuse
  stale transform output across modes.

### Patch Changes

- Updated dependencies [df4ed26]
  - @fictjs/compiler@0.22.0

## 0.21.0

### Minor Changes

- Harden function splitting by resolving handler helpers and dependencies through Babel scope analysis, preserving split sourcemaps, and documenting module-local dependency behavior.

### Patch Changes

- Updated dependencies
  - @fictjs/compiler@0.21.0

## 0.20.0

### Minor Changes

- Consume and publish library metadata, skip virtual module optimization when appropriate, and keep declaration output rooted correctly for library builds.

### Patch Changes

- Updated dependencies
  - @fictjs/compiler@0.20.0

## 0.19.0

### Minor Changes

- Emit library metadata assets and declarations, and harden cache fingerprinting for remapped package metadata.

### Patch Changes

- Updated dependencies
  - @fictjs/compiler@0.19.0

## 0.18.0

### Patch Changes

- Updated dependencies
  - @fictjs/compiler@0.18.0

## 0.17.1

### Patch Changes

- Fix standard `fict` app installs so compiler-generated helpers resolve through `fict/internal` and `fict/loader` instead of requiring a separate top-level `@fictjs/runtime` install. This also adds the new `fict/internal`, `fict/internal/list`, and `fict/loader` bridge entrypoints and updates docs/examples to use the main `fict` package consistently.
- Updated dependencies
  - @fictjs/compiler@0.17.1

## 0.17.0

### Minor Changes

- Restore split handlers from transform cache and pick up module-QRL resumable handler output.

### Patch Changes

- Updated dependencies
  - @fictjs/compiler@0.17.0

## 0.16.0

### Minor Changes

- Publish plugin with map-key and tooling-analysis compiler output; no plugin runtime behavior changed.

### Patch Changes

- Updated dependencies
  - @fictjs/compiler@0.16.0

## 0.15.0

### Minor Changes

- Reset transform metadata between builds and preserve compiler dependency and spread semantics.

### Patch Changes

- Updated dependencies
  - @fictjs/compiler@0.15.0

## 0.14.0

### Minor Changes

- Preserve parse error causes for Vite diagnostics.

### Patch Changes

- Updated dependencies
  - @fictjs/compiler@0.14.0

## 0.13.0

### Minor Changes

- Publish plugin with the MCP launch release train; no plugin behavior changed in this release.

### Patch Changes

- Updated dependencies
  - @fictjs/compiler@0.13.0

## 0.12.0

### Minor Changes

- Publish plugin with the strict diagnostic compiler release; no plugin behavior changed in this release.

### Patch Changes

- Updated dependencies
  - @fictjs/compiler@0.12.0

## 0.11.0

### Minor Changes

- Publish plugin with ownerDocument/runtime and compiler callback fixes used by transformed output.

### Patch Changes

- Updated dependencies
  - @fictjs/compiler@0.11.0

## 0.10.0

### Minor Changes

- Publish plugin with resumable-event, keyed-list, and state-write compiler fixes used by transformed output.

### Patch Changes

- Updated dependencies
  - @fictjs/compiler@0.10.0

## 0.9.0

### Minor Changes

- Publish plugin with strict guarantee defaults and compiler config profile updates.

### Patch Changes

- Updated dependencies
  - @fictjs/compiler@0.9.0

## 0.8.0

### Minor Changes

- Publish plugin with HIR fuzz and alias diagnostic compiler fixes.

### Patch Changes

- Updated dependencies
  - @fictjs/compiler@0.8.0

## 0.7.0

### Minor Changes

- Publish plugin with compiler metadata cache and codegen refactor updates.

### Patch Changes

- Updated dependencies
  - @fictjs/compiler@0.7.0

## 0.6.0

### Minor Changes

- Publish plugin with control-flow, HIR, and Babel compatibility compiler fixes.

### Patch Changes

- Updated dependencies
  - @fictjs/compiler@0.6.0

## 0.5.2

### Patch Changes

- Handle SSR logging during the streaming and renderToPartial updates.
- Updated dependencies
  - @fictjs/compiler@0.5.2

## 0.5.1

### Patch Changes

- Publish plugin with the Fict cleanup and router type patch; no plugin behavior changed in this patch.
- Updated dependencies
  - @fictjs/compiler@0.5.1

## 0.5.0

### Minor Changes

- Publish plugin with the SSR, router, and testing-library release train; no plugin behavior changed in this release.

### Patch Changes

- Updated dependencies
  - @fictjs/compiler@0.5.0

## 0.4.0

### Minor Changes

- Refresh plugin package metadata for release packaging.

### Patch Changes

- Updated dependencies
  - @fictjs/compiler@0.4.0

## 0.3.0

### Minor Changes

- Add cross-module metadata resolution used by Vite transforms.

### Patch Changes

- Updated dependencies
  - @fictjs/compiler@0.3.0

## 0.2.3

### Patch Changes

- Publish plugin with compiler cross-module metadata and dynamic key narrowing fixes.
- Updated dependencies
  - @fictjs/compiler@0.2.3

## 0.2.2

### Patch Changes

- Add incremental TypeScript project support and transform cache coverage.
- Updated dependencies
  - @fictjs/compiler@0.2.2

## 0.2.1

### Patch Changes

- Publish plugin with the HIR optimizer, `@fictReturn`, and macro state and memo fixes.
- Updated dependencies
  - @fictjs/compiler@0.2.1

## 0.2.0

### Minor Changes

- Publish plugin with compiler/runtime integration, suspension handling, sourcemap, and e2e coverage fixes.

### Patch Changes

- Updated dependencies
  - @fictjs/compiler@0.2.0

## 0.1.0

### Minor Changes

- Publish plugin with DOM binding, lifecycle, createRoot inheritance, and runtime stability fixes.

### Patch Changes

- Updated dependencies
  - @fictjs/compiler@0.1.0

## 0.0.15

### Patch Changes

- Publish plugin with props API fixes and initial router package scaffolding.
- Updated dependencies
  - @fictjs/compiler@0.0.15

## 0.0.14

### Patch Changes

- Publish plugin with delegated event, prop API, signal export, and state refactors.
- Updated dependencies
  - @fictjs/compiler@0.0.14

## 0.0.13

### Patch Changes

- Publish plugin with SSA/destructuring, unkeyed list rendering, and dev-mode size fixes.
- Updated dependencies
  - @fictjs/compiler@0.0.13

## 0.0.12

### Patch Changes

- Publish plugin with runtime ESM key, disposal, reorder, and package metadata fixes.
- Updated dependencies
  - @fictjs/compiler@0.0.12

## 0.0.11

### Patch Changes

- Publish plugin with event handler invocation and effect cleanup fixes.
- Updated dependencies
  - @fictjs/compiler@0.0.11

## 0.0.10

### Patch Changes

- Publish plugin with early integration and performance fixes.
- Updated dependencies
  - @fictjs/compiler@0.0.10

## 0.0.9

### Patch Changes

- Publish plugin with sourcemap, host root, SVG, and list rendering fixes.
- Updated dependencies
  - @fictjs/compiler@0.0.9

## 0.0.8

### Patch Changes

- Publish plugin with reactivity semantics, `$state`, hooks, and store dependency fixes.
- Updated dependencies
  - @fictjs/compiler@0.0.8

## 0.0.7

### Patch Changes

- Fix Vite plugin configuration for published package resolution.
- Updated dependencies
  - @fictjs/compiler@0.0.7

## 0.0.6

### Patch Changes

- Align Vite plugin configuration and version metadata for the release.
- Updated dependencies
  - @fictjs/compiler@0.0.6

## 0.0.5

### Patch Changes

- Fix compiler hoisted-function handling.
- Updated dependencies
  - @fictjs/compiler@0.0.5

## 0.0.4

### Patch Changes

- Fix runtime event handler behavior.
- Fix compiler accessor handling.
- Updated dependencies
  - @fictjs/compiler@0.0.4
