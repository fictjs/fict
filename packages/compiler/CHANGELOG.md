# @fictjs/compiler

## 0.32.0-next.0

### Minor Changes

- Implement the non-default Rust compiler modes for development metadata, eager conditionals,
  uncached getters, full optimization, and retained derived memos.

### Patch Changes

- Publish a machine-readable manifest scoped to certified behavior-variant options, and reject
  native binaries whose capability digest or package version does not match the JavaScript facade.
- Bind release certification to the exact package version, tag revision, native build, and frozen
  Babel 0.28 compatibility corpus, including replay through clean-installed release tarballs.
- Preserve effective unambiguous module kinds, partial metadata states, awaited JSX bindings, and
  function-valued state call semantics across the Rust compiler pipeline.
- Infer source language and CommonJS mode from a recognized physical filename extension before a
  query or fragment suffix, while preserving literal `?` and `#` path segments without extensions.
- Reject malformed or over-depth module metadata consistently in JavaScript graph hosts and the
  Rust compiler.
- Require standard decorators to be lowered by a target-compatible transform before native Fict
  compilation; raw decorator syntax fails closed.
- Normalize multiline authored JSX text using standard JSX whitespace rules. Use expression
  strings when exact whitespace is required, including inside `<pre>`.

## 0.31.0

### Breaking Changes

- Remove the legacy TypeScript/Babel compiler stack and make the Rust native compiler mandatory.
  - `@fictjs/compiler` now exposes only the Rust request API; `./legacy` and `createFictPlugin` are removed.
  - `@fictjs/vite-plugin` no longer accepts legacy or shadow backend selection and always uses the native compiler.
  - `@fictjs/webpack-plugin` no longer provides the Babel preset/legacy loader path and requires the native compiler.
  - `@fictjs/babel-preset` is retired; `0.30.1` remains the final legacy-compatible release and rollback target.

  Follow `docs/migration-guide.md` before upgrading. Native compiler installation failures now fail closed instead of falling back to Babel.

## 0.30.1

## 0.30.0

### Minor Changes

- 901347c: Complete the first stable Rust-default compatibility window with immutable
  publication and real-consumer evidence while retaining whole-build legacy
  rollback.

## 0.29.0

### Minor Changes

- 192cf64: Add synchronous and worker-pool native transform methods with structured
  malformed-input, parser, and contained-panic results.
- 192cf64: Expose the structured diagnostic types used by the native compiler protocol,
  including source spans, secondary labels, remediation, and guarantee classes.
- 192cf64: Add the serializable module metadata snapshot types for native compilation,
  including explicit resolved, opaque, missing, and incomplete-cycle states.
- 192cf64: Add the experimental `@fictjs/compiler/native` loader for fail-closed selection
  and validation of the Rust compiler platform package.
- 192cf64: Add serializable native TypeScript compatibility options for namespaces, type
  imports, enum optimization, class fields, and module-extension rewriting.
- 192cf64: Expose the native compiler build ID through the platform binding so caches,
  shadow comparisons, and whole-build rollback can reject mixed artifacts.
- c8ab75e: Make the OXC/Rust compiler the package-root and Vite default for the 0.29.0
  compatibility release while retaining explicit whole-build legacy rollback.
- 192cf64: Add the Babel-free `@fictjs/compiler/graph-host` entrypoint for bundler-owned
  module metadata resolution and persistence.
- 192cf64: Expose lazy `transform`, `scan`, and `analyze` request functions from
  `@fictjs/compiler/native`, backed by one validated OXC/Rust compiler binding
  with no per-file legacy fallback.
- 192cf64: Add the explicit `@fictjs/compiler/legacy` compatibility entrypoint and migrate
  the Babel preset and Vite rollback path to it ahead of the Rust-default package
  root transition.
- 192cf64: Add the serializable native `CompileRequest` and `CompileResult` protocol types,
  including source maps, compiler options, artifacts, explanations, and stats.

### Patch Changes

- 192cf64: Expose the Git revision embedded in controlled native compiler builds and bind
  Rust rollout evidence to that exact revision before a candidate can be sealed.
- 192cf64: Run complete native release certification for manual and tag workflows, retain
  its machine-readable artifact, and require it before npm publication.
- 192cf64: Return an explicit `null` native compiler revision for uncontrolled local builds
  so the JavaScript loader accepts the documented local N-API metadata contract.
- 192cf64: Require Rust-default approval to bind an intact 8-target by 2-Node native
  certification to the exact consecutive rollout candidate source and build.
- 192cf64: Bind the complete native runtime evidence matrix to the exact eight platform
  bundles that the release job will publish.
- 192cf64: Align the OXC runtime helper package with the exact OXC release compiled into
  the native compiler, and fail release validation if the Rust and npm versions
  drift again.
- 192cf64: Block native compiler publication unless the complete 8-target by 2-Node
  runtime matrix certifies one source revision, compiler build, package version,
  and per-target bundle.

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
