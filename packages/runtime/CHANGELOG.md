# @fictjs/runtime

## 0.24.0

### Minor Changes

- Prevent dynamic child bindings from tracking signal reads that happen while a
  child node or component is being created.
  - Conditional children now avoid unnecessary remounts when setup-only signals
    read during child creation are updated later.

## 0.23.0

### Minor Changes

- Migrate runtime package builds from `tsup` to `tsdown` while preserving the
  public runtime, JSX runtime, JSX dev runtime, internal, loader, and development
  entrypoints across CJS and ESM outputs.
  - Clean builds continue to regenerate the full runtime artifact set before
    publication.

## 0.22.0

### Minor Changes

- df4ed26: Harden runtime scheduling, store, and recovery semantics after the
  release verification gate.
  - Pending flush queues now survive throwing effects and cleanup callbacks, and
    cached memo errors are rethrown instead of returning stale values.
  - Effects that write their own dependencies are scheduled for another pass
    instead of being skipped.
  - Stores now support Map/Set-like collections and internal-slot objects with
    coarse-grained notifications.
  - Duplicate keyed-list identities are pruned after each diff, and
    array-shaped `resetKeys` are compared element-by-element.

## 0.21.0

### Minor Changes

- Make tracked branch remounts transactional, preserve foreign control state, and harden cleanup registries, hydration diagnostics, and resumable event recovery.

## 0.20.0

### Minor Changes

- Add explicit reactive getter enforcement, snapshot migrations, loader diagnostics, hydration warnings, and devtools protocol helpers.

## 0.19.0

### Minor Changes

- Publish runtime with the library metadata and cache-fingerprint release train; no runtime API behavior changed in this release.

## 0.18.0

### Patch Changes

- Publish runtime with the strict diagnostics release train; no runtime API behavior changed.

## 0.17.1

### Patch Changes

- Harden cleanup ownership, delegated/spread event semantics, DOM spread children, ref assignment, provider rendering, and hydration spread handling.

## 0.17.0

### Minor Changes

- Add resumable event prop typings and stabilize relative QRL lookup, first-event hydration control state, and data URL imports.

## 0.16.0

### Minor Changes

- Publish runtime with the map-key validation and tooling analysis release; no runtime behavior changed in this release.

## 0.15.0

### Minor Changes

- Lazily allocate store signals, reset SSR tracking state when disabled, and clear delegated/tuple handlers on prop updates.

## 0.14.0

### Minor Changes

- Document multi-document rendering expectations and clean lint-only runtime paths.

## 0.13.0

### Minor Changes

- Publish runtime with the MCP launch release train; no runtime behavior changed in this release.

## 0.12.0

### Minor Changes

- Publish runtime with the strict-guarantee fixture release; no runtime behavior changed in this release.

## 0.11.0

### Minor Changes

- Use ownerDocument consistently for keyed lists, portals, markers, text bindings, and loader prefetch links.

## 0.10.0

### Minor Changes

- Guard resumable loader event failures, handle rejected async transitions, and keep effect timing instrumentation out of production hot paths.

## 0.9.0

### Minor Changes

- Reduce tracked-branch churn, avoid duplicate fallback renders, expand patch coverage, and harden structural patching.

## 0.8.0

### Minor Changes

- Publish runtime with the compiler HIR invariant release; no runtime behavior changed in this release.

## 0.7.0

### Minor Changes

- Harden signal dependency cleanup, transition pending state, non-reactive binding escapes, nested store reconciliation, and callback-prop getter fallback.

## 0.6.0

### Minor Changes

- Publish runtime with the compiler control-flow and HIR release; no runtime behavior changed in this release.

## 0.5.2

### Patch Changes

- Publish runtime with the SSR streaming release; no runtime API behavior changed in this patch.

## 0.5.1

### Patch Changes

- Fix effect cleanup semantics, list rest parameters, and ShadowRoot list handling.

## 0.5.0

### Minor Changes

- Publish runtime with SSR hydration and event handling coverage; no standalone runtime API changed in this release.

## 0.4.0

### Minor Changes

- Refresh runtime package metadata for release packaging.

## 0.3.0

### Minor Changes

- Improve reactive runtime behavior, simplify event delegation, and drop queues when cycle guards are exceeded.

## 0.2.3

### Patch Changes

- Publish runtime with the cross-module metadata release; no runtime behavior changed in this patch.

## 0.2.2

### Patch Changes

- Fix store cache behavior and dangerouslySetInnerHTML support.

## 0.2.1

### Patch Changes

- Fix `$state`/`$memo` macro integration and runtime type annotations.

## 0.2.0

### Minor Changes

- Fix suspended rendering behavior and add cycle protection coverage.

## 0.1.0

### Minor Changes

- Fix DOM binding and lifecycle behavior, and add explicit createRoot inheritance opt-in.

## 0.0.15

### Patch Changes

- Publish runtime with the props API release train.

## 0.0.14

### Patch Changes

- Unify the delegated event list, refactor public exports, and remove `useProp`.

## 0.0.13

### Patch Changes

- Use fine-grained keyed lists for unkeyed rendering and keep list items as raw primitives.

### Breaking Changes

- Remove list-container helper exports (`createKeyedListContainer`, `createKeyedBlock`, `moveMarkerBlock`, `destroyMarkerBlock`, `getFirstNodeAfter`) from the public runtime API; use `createKeyedList` instead.

## 0.0.12

### Patch Changes

- Fix ESM key handling, disposal, reorderBySwap, and runtime types.

## 0.0.11

### Patch Changes

- Fix effect cleanup behavior.

## 0.0.10

### Patch Changes

- Improve early runtime performance and integration stability.

## 0.0.9

### Patch Changes

- Fix host root, SVG, and list rendering behavior.

## 0.0.8

### Patch Changes

- Fix dependency tracking for store and reactivity updates.

## 0.0.7

### Patch Changes

- Fix runtime package configuration.

## 0.0.6

### Patch Changes

- Align runtime package version metadata.

## 0.0.5

### Patch Changes

- Fix compiler hoisted-function handling.

## 0.0.4

### Patch Changes

- Fix runtime event handler behavior.
- Fix compiler accessor handling.
