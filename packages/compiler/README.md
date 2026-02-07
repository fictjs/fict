# @fictjs/compiler

![Node CI](https://github.com/fictjs/fict/workflows/CI/badge.svg)
![npm](https://img.shields.io/npm/v/fict.svg)
![license](https://img.shields.io/npm/l/fict)

Babel plugin for Fict Compiler

## Usage

```bash
npm install -D @fictjs/compiler
# or
yarn add -D @fictjs/compiler
```

You can visit [Fict](https://github.com/fictjs/fict) for more documentation.

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

- `dev` (default: `NODE_ENV !== 'production' && NODE_ENV !== 'test'`): enables compiler warnings/diagnostics. Set to `false` to silence warnings.
- `onWarn`: custom warning handler (only called when `dev` is enabled).
- `fineGrainedDom` (default: `true`): emits template-first fine-grained DOM operations for supported JSX.
- `lazyConditional` (default: `true`): enables control-flow lazy lowering for reactive branch returns where supported.
- `getterCache` (default: `true`): caches repeated getter reads within the same synchronous block.
- `optimize` (default: `true`): enables optimizer passes.
- `optimizeLevel` (default: `'safe'`): conservative algebraic optimization level.
- `inlineDerivedMemos` (default: `true`): allow the compiler to inline single-use derived values. Set to `false` for a “strict memo” mode where user-named derived values keep explicit memo accessors (unless `"use no memo"` disables memoization).
- `strictReactivity` (default: `false`): treat control-flow fallback diagnostics (`FICT-R003`, `FICT-R006`) as build errors. Useful for CI gates that require deterministic fine-grained reactivity without fallback paths.
- `strictGuarantee` (default: `true`): fail-closed mode for reactivity guarantees. Non-guaranteed reactivity diagnostics (including control-flow fallback and props fallback classes) are treated as hard errors and cannot be suppressed/downgraded.
  - Opt-out: set `strictGuarantee: false` to compile in non-strict mode.
  - CI override: set `FICT_STRICT_GUARANTEE=1` to force-enable `strictGuarantee` even when options request opt-out.
  - Contract fixtures: see `packages/compiler/test/reactivity-guarantee-contract.test.ts` for the maintained guarantee/fallback/unsupported matrix checks.
- `emitModuleMetadata`:
  - `true`: always write adjacent `.fict.meta.json` sidecar files next to source files.
  - `false`: never write metadata files.
  - `'auto'` (default): writes metadata to cache directory (not source tree) only when no external metadata store/resolver is provided.
- `moduleMetadataCacheDir` (default: `<cwd>/.fict-cache/metadata`): cache directory used by `emitModuleMetadata: 'auto'`.
- `moduleMetadata` / `resolveModuleMetadata`: external metadata integration hooks. When provided, `'auto'` does not write metadata files.
- `reactiveScopes`: function names whose **first callback argument** is treated as a component-like reactive scope.
  - Only **direct calls** are recognized (e.g., `renderHook(() => ...)` or `utils.renderHook(() => ...)`).
  - **Aliases/indirect calls** are not recognized (e.g., `const rh = renderHook; rh(() => ...)`).

Recommended environment presets: `docs/config-profiles.md`.
