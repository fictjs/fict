# @fictjs/router

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
