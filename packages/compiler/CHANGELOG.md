# @fictjs/compiler

## 0.28.0

### Breaking Changes

- **Preview resumability:** runtime-source detection now recognizes
  `fict/experimental/loader` and `@fictjs/runtime/experimental/loader` instead
  of the former `/loader` subpaths. Update loader imports before compiling
  resumable applications with 0.28.

### Minor Changes

- Mark `resumable`, `autoExtractHandlers`, and `autoExtractThreshold` as
  experimental compiler options. Their generated ABI remains outside the Core
  1.0 compatibility promise; supported non-resumable code generation keeps its
  existing defaults.

## 0.27.0

### Minor Changes

- Lower TypeScript before Fict analysis and support TypeScript enums,
  namespaces, supported declare fields, TypeScript-only tooling inputs, and
  CommonJS top-level returns. Reactive namespace exports retain their metadata
  and runtime behavior across files.
- Preserve namespace semantics through polymorphic and render-only JSX,
  deferred branches, SVG/MathML/HTML transitions, and implicit table
  colgroups. Qualified `xlink:`/`xml:` names and custom-event casing now
  survive both static and dynamic code generation.
- Keep JSX-valued component props and children as VNodes until the receiving
  component materializes them, so provider, router, Suspense, and boundary
  ownership is established before nested consumers execute.
- Mark the built-in ErrorBoundary and Suspense reset getters as reactive
  without changing ordinary callback-prop tracking.
- Harden cross-module metadata generation and caching around missing files,
  namespace wrappers, importer-first builds, disk markers, and package-facade
  boundaries.
- Publish condition-specific CommonJS declarations so Node16/NodeNext
  TypeScript consumers resolve the compiler through generated `.d.cts`
  output.

## 0.26.0

### Minor Changes

- Publish the compiler with the 0.26 release train.
  - No compiler transform, diagnostic, or public API behavior changed in this
    release.

## 0.25.0

### Minor Changes

- Fix compiler codegen state isolation and hook return accessor preservation.
  - Function-level codegen context is now restored consistently across pure
    function early exits, preventing hook/component/props/resumable state from
    leaking into later lowered functions.
  - Hook return accessor preservation now stops at nested function boundaries,
    so helper functions inside hooks keep explicit signal reads such as
    `return count()` while top-level hook returns still expose accessors.
  - Compiler maintenance guardrails now cover complexity budgets, diagnostic
    docs coverage, strict-default smoke tests, HIR output budgets, and warning
    channel documentation more reliably.

## 0.24.0

### Minor Changes

- Publish the compiler with the 0.24 release train.
  - No compiler transform, diagnostic, or public API behavior changed in this
    release.

## 0.23.0

### Minor Changes

- Migrate the compiler build from `tsup` to `tsdown` while preserving the
  published CJS/ESM entrypoints, declaration files, and sourcemaps.
  - Babel runtime dependencies remain externalized where consumers provide them,
    while required helper packages stay bundled into the compiler output.
  - Cache fingerprint coverage now follows the source-mapped artifact that
    tsdown loads during local verification.

## 0.22.0

### Minor Changes

- df4ed26: Harden strict compiler semantics after the release verification gate.
  - Compiler cache fingerprints now reflect current source artifacts more
    reliably, including source-mode and unreadable-artifact cases.
  - Supported `try`/`catch`, switch, loop, branch, and story-block lowering paths
    preserve reactive behavior more consistently; unsupported static loop
    fallbacks now produce diagnostics instead of silently losing reactivity.
  - Region memoization keeps side effects, local object mutations, closure
    mutations, member writes, and branch-local values ordered conservatively.
  - Hook return analysis rejects inconsistent accessor shapes, opaque branches,
    alias conflicts, and escaped hook accessors before codegen can emit unstable
    output.
  - JSX, portal, spread, optional-call, array-callback, and dependency-shape
    analysis now covers more strict-mode edge cases with targeted diagnostics.

## 0.21.0

### Minor Changes

- Keep clean-build compiler type imports stable and expand conformance and release verification coverage for strict guarantee behavior.

## 0.20.0

### Minor Changes

- Add package metadata ABI handling, reactive callback escape analysis, and source minimizer/explain artifacts for cleaner diagnostics.

## 0.19.0

### Minor Changes

- Add published package metadata support and harden compiler cache fingerprinting for remapped artifacts and package declarations.

## 0.18.0

### Minor Changes

- Improve compiler diagnostics so strict defaults, fallback analysis, diagnostic codes, and source locations stay consistent across direct compiler errors and tooling consumers.
- Add new validation warnings for nested hook and state placement, inline JSX function props, native element spreads, index-based list keys, and memo constants without reactive dependencies.

## 0.17.1

### Patch Changes

- Fix standard `fict` app installs so compiler-generated helpers resolve through `fict/internal` and `fict/loader` instead of requiring a separate top-level `@fictjs/runtime` install. This also adds the new `fict/internal`, `fict/internal/list`, and `fict/loader` bridge entrypoints and updates docs/examples to use the main `fict` package consistently.

## 0.17.0

### Minor Changes

- Register resumable handlers with module QRLs and preserve looped resumable handlers through structurized control flow.

## 0.16.0

### Minor Changes

- Validate keys across map branches, optional maps, ternaries, sequence expressions, and expose tooling analysis APIs.

## 0.15.0

### Minor Changes

- Unify expression dependency walking, support intrinsic spread and function-valued spread semantics, and clear fused patch groups safely.

## 0.14.0

### Minor Changes

- Keep logical branch and dependency-key regressions covered, and remove lint-only dead assignments from analysis passes.

## 0.13.0

### Minor Changes

- Publish compiler output used by the new MCP diagnostics and autofixer workflows.

## 0.12.0

### Minor Changes

- Avoid false R002 diagnostics for core callback-host APIs under strict guarantee defaults.

## 0.11.0

### Minor Changes

- Detect conditional hook and effect calls in logical short-circuit expressions and normalize dependency keys with SSA naming.

## 0.10.0

### Minor Changes

- Preserve delegated and resumable event semantics, keyed-list aliases, resumable captures, and tracked state write return values.

## 0.9.0

### Minor Changes

- Add strict reactivity and strict guarantee modes, and widen branch fallback detection for IIFEs, store reads, and destructuring.

## 0.8.0

### Minor Changes

- Harden HIR fuzz invariants and alias diagnostics.

## 0.7.0

### Minor Changes

- Fix alias reassignment, cache module metadata, warn on reactive control-flow reexecution, and split codegen helpers.

## 0.6.0

### Minor Changes

- Make try/switch return branches reactive, harden control-flow lowering, support object methods/accessors in HIR, and improve Babel compatibility.

## 0.5.2

### Patch Changes

- Publish compiler with the SSR streaming release; no compiler behavior changed in this patch.

## 0.5.1

### Patch Changes

- Publish compiler with the Fict cleanup and router type patch; no compiler behavior changed in this patch.

## 0.5.0

### Minor Changes

- Publish compiler with the SSR, router, and testing-library release train; no compiler behavior changed in this release.

## 0.4.0

### Minor Changes

- Refresh compiler package metadata for release packaging.

## 0.3.0

### Minor Changes

- Restrict delegated event extraction to simple function calls and support cross-module metadata consumed by Vite.

## 0.2.3

### Patch Changes

- Add cross-module reactive metadata and enhanced dynamic key narrowing.

## 0.2.2

### Patch Changes

- Add key narrowing, RegExp/BigInt/dynamic import/import.meta support, destructuring assignments, and signal setter fixes.

## 0.2.1

### Patch Changes

- Add the HIR optimizer with DCE/CSE/constant propagation and support `@fictReturn` annotations.

## 0.2.0

### Minor Changes

- Fix selector hoisting and compiler/runtime integration, with sourcemap and e2e coverage.

## 0.1.0

### Minor Changes

- Publish compiler with lifecycle/runtime integration fixes from initial e2e hardening.

## 0.0.15

### Patch Changes

- Fix compiler props APIs.

## 0.0.14

### Patch Changes

- Fix `$state` handling during the API refactor.

## 0.0.13

### Patch Changes

- Fix SSA and deep destructuring transforms and remove public list-container helper dependencies.

## 0.0.12

### Patch Changes

- Publish compiler with the runtime ESM/disposal release; no compiler behavior changed in this patch.

## 0.0.11

### Patch Changes

- Fix event handler call lowering.

## 0.0.10

### Patch Changes

- Remove stray compiler logging and keep early performance fixes aligned.

## 0.0.9

### Patch Changes

- Publish compiler with sourcemap, host root, SVG, and list rendering fixes.

## 0.0.8

### Patch Changes

- Fix reactivity semantics, `$state` and hooks rules, and `$store` auto-memo output.

## 0.0.7

### Patch Changes

- Fix compiler package configuration.

## 0.0.6

### Patch Changes

- Align compiler package version metadata.

## 0.0.5

### Patch Changes

- Fix compiler hoisted-function handling.

## 0.0.4

### Patch Changes

- Fix runtime event handler behavior.
- Fix compiler accessor handling.
