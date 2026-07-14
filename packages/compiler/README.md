# @fictjs/compiler

![Node CI](https://github.com/fictjs/fict/workflows/CI/badge.svg)
![npm](https://img.shields.io/npm/v/fict.svg)
![license](https://img.shields.io/npm/l/fict)

Babel plugin for Fict Compiler

## Usage

```bash
npm install fict
npm install -D @fictjs/compiler
# or
yarn add fict
yarn add -D @fictjs/compiler
```

You can visit [Fict](https://github.com/fictjs/fict) for more documentation.

For typical apps, install `fict` as the runtime dependency and let compiler output target the same package family. Direct `@fictjs/runtime` usage remains supported for lower-level integrations, but your source imports should stay on one package family.

Compiler-generated getters are marked explicitly for the runtime. Runtime no
longer relies on zero-argument function arity to infer reactivity, so user
callbacks such as `() => start()` stay callbacks unless code explicitly wraps
them with `reactive(fn)`.

## Native compiler beta

Official Vite and Webpack integrations own module graphs and are preferred for
applications. A direct integration can call the lazy OXC/Rust facade exported
by `@fictjs/compiler/native`:

```ts
import { transformSync } from '@fictjs/compiler/native'

const result = transformSync({
  code: source,
  filename: 'src/App.tsx',
  moduleId: 'src/App.tsx',
  options: { strictGuarantee: true, sourcemap: true },
  metadata: [],
})
```

The subpath also exports `transform`, `scan`/`scanSync`,
`analyze`/`analyzeSync`, and `nativeCompilerInfo`. The native package is loaded
on the first request and the facade reuses one validated compiler binding for
the process. Set `FICT_COMPILER_NATIVE_PATH` only for local development or
release verification; normal installations select the platform optional
package automatically. Low-level hosts that need an isolated binding may use
`createNativeCompilerFacade(options)` or `loadNativeCompilerBinding(options)`.

Bundlers that own package resolution and metadata persistence should import
those Node-side services from `@fictjs/compiler/graph-host`:

```ts
import {
  parseModuleReactiveMetadata,
  resolvePackageModuleMetadata,
} from '@fictjs/compiler/graph-host'
```

The graph-host entry may access the filesystem, but it does not load Babel or
the legacy compiler. Keep graph callbacks and bundler objects in this host
layer; pass only serializable metadata snapshots to the native request facade.

The package root remains the Babel plugin during the beta compatibility window.
Code that intentionally owns legacy rollback should import
`@fictjs/compiler/legacy`; this explicit subpath will remain the compatibility
entry when the package root becomes the Rust request facade in a breaking
release.

The request boundary is serializable. Host callbacks, filesystem resolution,
and bundler graph objects must stay outside Rust. A build must use one compiler
build identifier and one backend; do not catch a native failure and compile
only that file with the legacy Babel plugin.

Platform support and installation behavior are defined by
[ADR-0002](../../docs/adr/0002-native-compiler-support-matrix.md). Promotion,
performance/RSS evidence, and rollback are defined by the
[Rust compiler rollout](../../docs/features/rust-compiler-rollout/rollout.md).

## Options

```ts
createFictPlugin({
  dev: true,
  onWarn(warning) {
    console.warn(warning)
  },
  // Keep single-use derived values as memos (strict memo mode)
  // inlineDerivedMemos: false,
  // Metadata write mode:
  // - true: write adjacent sidecar files
  // - false: never write files
  // - auto (default): write to cache dir only when needed
  // emitModuleMetadata: 'auto',
  // moduleMetadataCacheDir: '.fict-cache/metadata',
  // Allow $state/$effect inside reactive-scope callbacks (e.g., renderHook(() => ...))
  reactiveScopes: ['renderHook'],
})
```

- `dev` (default: `NODE_ENV !== 'production' && NODE_ENV !== 'test'`): controls whether development diagnostics are emitted through the compiler warning channel. Integrations should provide `onWarn` to surface warnings in CLI, Vite, editor, or playground output.
- `onWarn`: custom warning handler. When provided, warn-level diagnostics are delivered to the handler even in `dev: false` opt-out builds; `strictGuarantee`, `strictReactivity`, `warningsAsErrors`, and default error-level diagnostics can still fail the build.
- `fineGrainedDom` (default: `true`): emits template-first fine-grained DOM operations for supported JSX.
- `lazyConditional` (default: `true`): enables control-flow lazy lowering for reactive branch returns where supported. When active branch reads require fallback re-execution, branch output is remounted instead of partially patched.
- `getterCache` (default: `true`): caches repeated getter reads within the same synchronous block.
- `optimize` (default: `true`): enables optimizer passes.
- `optimizeLevel` (default: `'safe'`): conservative algebraic optimization level.
- `inlineDerivedMemos` (default: `true`): allow the compiler to inline single-use derived values. Set to `false` for a “strict memo” mode where user-named derived values keep explicit memo accessors (unless `"use no memo"` disables memoization).
- `strictReactivity` (default: `false`): treat control-flow fallback diagnostics (`FICT-R003`, `FICT-R006`) as build errors. Useful for CI gates that require deterministic fine-grained reactivity without fallback paths.
- `strictGuarantee` (default: `true`): fail-closed mode for reactivity guarantees. Non-guaranteed reactivity diagnostics (including control-flow fallback and props fallback classes) are treated as hard errors and cannot be suppressed/downgraded.
  - Production override: `NODE_ENV=production` force-enables `strictGuarantee` even when options request opt-out.
  - Opt-out: set `strictGuarantee: false` only in non-production migration or benchmark builds.
  - CI override: set `FICT_STRICT_GUARANTEE=1` to force-enable `strictGuarantee` even when options request opt-out.
  - Contract fixtures: see `packages/compiler/test/reactivity-guarantee-contract.test.ts` for the maintained guarantee/fallback/unsupported matrix checks.
- `emitModuleMetadata`:
  - `true`: always write adjacent `.fict.meta.json` sidecar files next to source files.
  - `false`: never write metadata files.
  - `'auto'` (default): writes metadata to cache directory (not source tree) only when no external metadata store/resolver is provided.
- `moduleMetadataCacheDir` (default: `<cwd>/.fict-cache/metadata`): cache directory used by `emitModuleMetadata: 'auto'`.
- `moduleMetadata` / `resolveModuleMetadata`: external metadata integration hooks. When provided, `'auto'` does not write metadata files.
  - Built-in metadata resolution covers local filesystem modules (relative/absolute paths + configured alias/ts resolution from the caller).
  - Bare package imports can opt in by publishing Fict package metadata in `package.json` (see `docs/third-party-libraries.md`).
  - Cross-module metadata lookup does not perform cycle detection; cyclical hook metadata chains should be handled by a custom resolver if needed.
- `reactiveScopes`: function names whose **first callback argument** is treated as a component-like reactive scope.
  - Only **direct calls** are recognized (e.g., `renderHook(() => ...)` or `utils.renderHook(() => ...)`).
  - **Aliases/indirect calls** are not recognized (e.g., `const rh = renderHook; rh(() => ...)`).

## Recommended Profiles

Use `docs/config-profiles.md` for copy-paste presets:

- strict default app profile (`strictGuarantee: true`)
- CI hard-gate profile
- non-production migration/benchmark profile (`strictGuarantee: false`)
- one-shot build profile (`emitModuleMetadata: false`)
