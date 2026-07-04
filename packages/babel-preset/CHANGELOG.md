# @fictjs/babel-preset

## 0.23.0

### Minor Changes

- Migrate the Babel preset build from `tsup` to `tsdown` while preserving the
  CJS/ESM preset entrypoints and declaration output.
  - Babel and compiler dependency boundaries remain stable for consuming Babel
    projects.

### Patch Changes

- Updated dependencies
  - @fictjs/compiler@0.23.0

## 0.22.0

### Minor Changes

- Publish the Babel preset with compiler 0.22 so Babel users pick up the strict
  lowering, hook-return validation, raw-text, and cache-fingerprint fixes from
  this release train.

### Patch Changes

- Updated dependencies [df4ed26]
  - @fictjs/compiler@0.22.0

## 0.21.0

### Minor Changes

- Publish the Babel preset against compiler 0.21 so transformed projects pick up the strict guarantee and release-verification fixes.

### Patch Changes

- Updated dependencies
  - @fictjs/compiler@0.21.0

## 0.20.0

### Minor Changes

- Publish the preset against compiler 0.20, including package metadata ABI support, cleaner type surfaces, and explain-artifact updates.

### Patch Changes

- Updated dependencies
  - @fictjs/compiler@0.20.0

## 0.19.0

### Minor Changes

- Publish the preset with the library metadata and cache-fingerprint release train so Babel users consume the current compiler output.

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

- Publish the preset with resumable handler QRL, split-handler cache, and hydration control-state fixes from the release train.

### Patch Changes

- Updated dependencies
  - @fictjs/compiler@0.17.0

## 0.16.0

### Minor Changes

- Publish the preset with map-key validation, tooling-analysis APIs, and editor analyzer updates from the release train.

### Patch Changes

- Updated dependencies
  - @fictjs/compiler@0.16.0

## 0.15.0

### Minor Changes

- Publish the preset with dependency-walking, metadata-reset, handler cleanup, and spread semantics fixes from the release train.

### Patch Changes

- Updated dependencies
  - @fictjs/compiler@0.15.0

## 0.14.0

### Minor Changes

- Publish the preset with MCP security hardening, parse-error preservation, and lint-cleanup fixes from the release train.

### Patch Changes

- Updated dependencies
  - @fictjs/compiler@0.14.0

## 0.13.0

### Minor Changes

- Publish the preset with the MCP docs, autofixer, playground-link, streamable HTTP, and docs-search release train.

### Patch Changes

- Updated dependencies
  - @fictjs/compiler@0.13.0

## 0.12.0

### Minor Changes

- Publish the preset with strict-guarantee fixture and callback-host diagnostic fixes from the release train.

### Patch Changes

- Updated dependencies
  - @fictjs/compiler@0.12.0

## 0.11.0

### Minor Changes

- Publish the preset with skill-library, ownerDocument rendering, and logical hook diagnostic fixes from the release train.

### Patch Changes

- Updated dependencies
  - @fictjs/compiler@0.11.0

## 0.10.0

### Minor Changes

- Publish the preset with resumable-event, keyed-list, state-write, playground, and devtools updates from the release train.

### Patch Changes

- Updated dependencies
  - @fictjs/compiler@0.10.0

## 0.9.0

### Minor Changes

- Publish the preset with strict guarantee defaults, tracked branch patching, and SSR resume contract hardening from the release train.

### Patch Changes

- Updated dependencies
  - @fictjs/compiler@0.9.0

## 0.8.0

### Minor Changes

- Publish the preset with HIR fuzz invariant and alias diagnostic fixes from the release train.

### Patch Changes

- Updated dependencies
  - @fictjs/compiler@0.8.0

## 0.7.0

### Minor Changes

- Publish the preset with compiler metadata cache, reactive control-flow, and runtime cleanup and performance fixes from the release train.

### Patch Changes

- Updated dependencies
  - @fictjs/compiler@0.7.0

## 0.6.0

### Minor Changes

- Publish the preset with control-flow lowering, HIR object method and accessor support, and Babel compatibility fixes from the release train.

### Patch Changes

- Updated dependencies
  - @fictjs/compiler@0.6.0

## 0.5.2

### Patch Changes

- Publish the preset with SSR streaming, renderToPartial, manifest, and backpressure updates from the release train.
- Updated dependencies
  - @fictjs/compiler@0.5.2

## 0.5.1

### Patch Changes

- Publish the preset with router typing, effect cleanup, list rest parameter, and ShadowRoot list fixes from the release train.
- Updated dependencies
  - @fictjs/compiler@0.5.1

## 0.5.0

### Minor Changes

- Publish the preset with core SSR, hydration, router, and testing-library updates from the release train.

### Patch Changes

- Updated dependencies
  - @fictjs/compiler@0.5.0

## 0.4.0

### Minor Changes

- Refresh package metadata for the release pipeline.

### Patch Changes

- Updated dependencies
  - @fictjs/compiler@0.4.0

## 0.3.0

### Minor Changes

- Publish the preset with reactive behavior, router, testing-library, devtools, and Vite metadata updates from the release train.

### Patch Changes

- Updated dependencies
  - @fictjs/compiler@0.3.0

## 0.2.3

### Patch Changes

- Publish the preset with cross-module reactive metadata and dynamic key narrowing fixes.
- Updated dependencies
  - @fictjs/compiler@0.2.3

## 0.2.2

### Patch Changes

- Publish the preset with key narrowing, transform cache, literal support, destructuring assignments, and store cache fixes.
- Updated dependencies
  - @fictjs/compiler@0.2.2

## 0.2.1

### Patch Changes

- Publish the preset with the HIR optimizer, `@fictReturn`, and macro state and memo fixes.
- Updated dependencies
  - @fictjs/compiler@0.2.1

## 0.2.0

### Minor Changes

- Publish the preset with compiler/runtime integration, suspension handling, sourcemap, and e2e coverage fixes.

### Patch Changes

- Updated dependencies
  - @fictjs/compiler@0.2.0

## 0.1.0

### Minor Changes

- Publish the preset with DOM binding, lifecycle, createRoot inheritance, and runtime stability fixes.

### Patch Changes

- Updated dependencies
  - @fictjs/compiler@0.1.0

## 0.0.15

### Patch Changes

- Publish the preset with props API fixes and initial router package scaffolding.
- Updated dependencies
  - @fictjs/compiler@0.0.15

## 0.0.14

### Patch Changes

- Publish the preset with delegated event, prop API, signal export, and state refactors.
- Updated dependencies
  - @fictjs/compiler@0.0.14

## 0.0.13

### Patch Changes

- Publish the preset with SSA/destructuring, unkeyed list rendering, and dev-mode size fixes.
- Updated dependencies
  - @fictjs/compiler@0.0.13

## 0.0.12

### Patch Changes

- Publish the preset with runtime ESM key, disposal, reorder, and package metadata fixes.
- Updated dependencies
  - @fictjs/compiler@0.0.12

## 0.0.11

### Patch Changes

- Publish the preset with event handler invocation and effect cleanup fixes.
- Updated dependencies
  - @fictjs/compiler@0.0.11

## 0.0.10

### Patch Changes

- Publish the preset with early integration and performance fixes.
- Updated dependencies
  - @fictjs/compiler@0.0.10

## 0.0.9

### Patch Changes

- Publish the preset with sourcemap, host root, SVG, and list rendering fixes.
- Updated dependencies
  - @fictjs/compiler@0.0.9

## 0.0.8

### Patch Changes

- Publish the preset with reactivity semantics, `$state`, hooks, and store dependency fixes.
- Updated dependencies
  - @fictjs/compiler@0.0.8

## 0.0.7

### Patch Changes

- Fix Babel preset configuration for published package resolution.
- Updated dependencies
  - @fictjs/compiler@0.0.7

## 0.0.6

### Patch Changes

- Align Babel preset configuration and version metadata for the release.
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
