# fict

## 0.21.0

### Minor Changes

- Improve uncompiled macro diagnostics and trim bundled dev-only diagnostic code while keeping the Fict runtime bridge aligned with runtime 0.21.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.21.0

## 0.20.0

### Minor Changes

- Surface the devtools protocol through the advanced entry point and keep reactive marker exports limited to advanced builds.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.20.0

## 0.19.0

### Minor Changes

- Resolve published Fict package metadata for library consumers and keep package configuration compatible with the Vite/Vitest updates.

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

- Align the root package with resumable event and hydration runtime/compiler fixes.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.17.0

## 0.16.0

### Minor Changes

- Update package release metadata and docs alongside map-key validation and analyzer tooling.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.16.0

## 0.15.0

### Minor Changes

- Align the root package with dependency walking, handler cleanup, and spread semantics fixes.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.15.0

## 0.14.0

### Minor Changes

- Align the root package with MCP security, diagnostics, and lint-cleanup fixes.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.14.0

## 0.13.0

### Minor Changes

- Publish the root package with the MCP tooling release train.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.13.0

## 0.12.0

### Minor Changes

- Stabilize e2e fixtures under strict-guarantee defaults.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.12.0

## 0.11.0

### Minor Changes

- Fix package types while adopting ownerDocument runtime and compiler callback fixes.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.11.0

## 0.10.0

### Minor Changes

- Publish the root package with resumable-event, keyed-list, state-write, playground, and devtools updates.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.10.0

## 0.9.0

### Minor Changes

- Avoid runtime pretest rebuild races under strict guarantee defaults.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.9.0

## 0.8.0

### Minor Changes

- Publish the root package with HIR fuzz and alias diagnostic fixes.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.8.0

## 0.7.0

### Minor Changes

- Improve package performance while adopting compiler metadata and runtime cleanup fixes.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.7.0

## 0.6.0

### Minor Changes

- Publish the root package with control-flow, HIR, and Babel compatibility compiler fixes.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.6.0

## 0.5.2

### Patch Changes

- Publish the root package with SSR streaming and renderToPartial support.
- Updated dependencies
  - @fictjs/runtime@0.5.2

## 0.5.1

### Patch Changes

- Fix effect cleanup semantics, list rest parameters, and ShadowRoot list support.
- Updated dependencies
  - @fictjs/runtime@0.5.1

## 0.5.0

### Minor Changes

- Fix SSR integration for the root package as core SSR and hydration support land.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.5.0

## 0.4.0

### Minor Changes

- Refresh root package metadata for release packaging.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.4.0

## 0.3.0

### Minor Changes

- Improve compiler/runtime reactive behavior, event delegation cycle guards, renderHook macros, and Vite package metadata resolution.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.3.0

## 0.2.3

### Patch Changes

- Publish the root package with cross-module reactive metadata and dynamic key narrowing fixes.
- Updated dependencies
  - @fictjs/runtime@0.2.3

## 0.2.2

### Patch Changes

- Enhance resources and dangerouslySetInnerHTML handling while adopting compiler and Vite transform cache fixes.
- Updated dependencies
  - @fictjs/runtime@0.2.2

## 0.2.1

### Patch Changes

- Fix `$state` and `$memo` macro behavior while adopting the HIR optimizer release.
- Updated dependencies
  - @fictjs/runtime@0.2.1

## 0.2.0

### Minor Changes

- Fix compiler integration, add more testing, and update documentation.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.2.0

## 0.1.0

### Minor Changes

- Fix lifecycle behavior and adopt DOM binding/createRoot runtime stability fixes.

### Patch Changes

- Updated dependencies
  - @fictjs/runtime@0.1.0

## 0.0.15

### Patch Changes

- Publish the root package with props API fixes and router package scaffolding.
- Updated dependencies
  - @fictjs/runtime@0.0.15

## 0.0.14

### Patch Changes

- Refactor the prop API and package exports.
- Updated dependencies
  - @fictjs/runtime@0.0.14

## 0.0.13

### Patch Changes

- Publish the root package with dev-mode and bundle-size fixes from the runtime/list release.
- Updated dependencies
  - @fictjs/runtime@0.0.13

## 0.0.12

### Patch Changes

- Publish the root package with runtime ESM key, disposal, reorder, and package metadata fixes.
- Updated dependencies
  - @fictjs/runtime@0.0.12

## 0.0.11

### Patch Changes

- Publish the root package with event handler invocation and effect cleanup fixes.
- Updated dependencies
  - @fictjs/runtime@0.0.11

## 0.0.10

### Patch Changes

- Improve early integration stability and performance.
- Updated dependencies
  - @fictjs/runtime@0.0.10

## 0.0.9

### Patch Changes

- Fix sourcemap, host root, SVG, and list behavior.
- Updated dependencies
  - @fictjs/runtime@0.0.9

## 0.0.8

### Patch Changes

- Fix dependency metadata around reactivity, `$state`, hooks, and store updates.
- Updated dependencies
  - @fictjs/runtime@0.0.8
  - @fictjs/vite-plugin@0.0.8

## 0.0.7

### Patch Changes

- Fix package configuration for the root package and dependencies.
- Updated dependencies
  - @fictjs/vite-plugin@0.0.7
  - @fictjs/runtime@0.0.7

## 0.0.6

### Patch Changes

- Align root package version metadata.
- Updated dependencies
  - @fictjs/runtime@0.0.6
  - @fictjs/vite-plugin@0.0.6

## 0.0.5

### Patch Changes

- Fix compiler hoisted-function handling.
- Updated dependencies
  - @fictjs/runtime@0.0.5
  - @fictjs/vite-plugin@0.0.5

## 0.0.4

### Patch Changes

- Fix runtime event handler behavior.
- Fix compiler accessor handling.
- Updated dependencies
  - @fictjs/runtime@0.0.4
  - @fictjs/vite-plugin@0.0.4
