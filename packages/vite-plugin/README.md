# @fictjs/vite-plugin

Official Vite integration for Fict's OXC/Rust compiler.

```bash
npm install fict
npm install --save-dev @fictjs/vite-plugin
```

```ts
import { defineConfig } from 'vite'
import fict from '@fictjs/vite-plugin'

export default defineConfig({
  plugins: [
    fict({
      cache: { persistent: true },
      useTypeScriptProject: true,
      tsconfigPath: './tsconfig.json',
      strictGuarantee: true,
      reactiveScopes: ['renderHook'],
    }),
  ],
})
```

Fict 0.31 is Rust-only. The plugin has no `backend` or `shadow` option and does
not read `FICT_COMPILER_BACKEND`, project Babel configuration, or the retired
`@fictjs/babel-preset`. Native compiler load and transform failures fail the
build. The only legacy recovery boundary is the complete application dependency
set pinned to `0.30.1`.

## Options

Integration defaults:

- `include`: all `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts`, and
  `.cts` modules;
- declaration files are never transformed;
- `exclude`: `['**/node_modules/**']`;
- `useTypeScriptProject`: `true`;
- `cache`: enabled in memory; persistent during `vite build` unless disabled;
- `strictGuarantee`: fail closed by default and forced in production;
- `functionSplitting`: enabled for production builds, used only with Preview
  resumability;
- `debug`: disabled; set `debug: true` or `FICT_VITE_PLUGIN_DEBUG=1` for plugin
  diagnostics.

Native lowering options such as `strictReactivity`, `warningLevels`,
`warningsAsErrors`, `fineGrainedDom`, `optimize`, and `reactiveScopes` are
accepted directly. `onWarn` and `explain` adapt structured native diagnostics
for the Vite host. `dev`, `lazyConditional`, and `getterCache` are also honored.
`optimizeLevel` supports the default conservative `'safe'` profile and the
opt-in `'full'` algebraic profile. The compatibility field
`inlineDerivedMemos` defaults to `true`; set it to `false` to preserve eligible
user-named single-use derived memos while retaining compiler-temp inlining.

`publicIdentityNamespace` provides a stable namespace for Preview resumable
output when no named package boundary owns the Vite root. Normal Core builds do
not need it.

Custom Babel or TypeScript transforms may run as separate downstream stages.
They must not compile Fict reactivity, and source maps must be composed by the
host. Standard decorators must instead be lowered before native Fict
compilation: register a target-compatible `enforce: 'pre'` transform before
`fict()` in the Vite plugin list. Raw standard decorator syntax fails with
`FICT-TS-DECORATOR-STANDARD`; legacy TypeScript parameter decorators remain on
Fict's explicit legacy lowering path.

## Preview resumability

`resumable: true` enables compiler-owned structured handler artifacts that Vite
turns into virtual modules without reparsing generated code. This remains
default-off Preview behavior and is excluded from the Core 1.0 compatibility
promise. See [PREVIEW](../../docs/PREVIEW.md) and the
[degradation audit](../../docs/preview-degradation-audit.md).

## Library publishing

Use `library: true` when publishing a third-party Fict hook library:

```ts
export default defineConfig({
  build: {
    lib: {
      entry: {
        index: 'src/index.ts',
        hooks: 'src/hooks.ts',
      },
      formats: ['es', 'cjs'],
    },
  },
  plugins: [fict({ library: true })],
})
```

Library mode:

- compiles public entry modules with the native compiler;
- emits versioned `*.fict.meta.json` assets into the build output;
- writes `package.json#fict.metadata` for one public entry or
  `package.json#fict.exports` for multiple entries;
- warns when an entry produces no metadata and fails when a generated asset
  cannot be mapped to a public package entry.

```json
{
  "fict": {
    "exports": {
      ".": "./dist/index.fict.meta.json",
      "./hooks": "./dist/hooks.fict.meta.json"
    }
  }
}
```

Configure output placement or package mutation when another release tool owns
the manifest:

```ts
fict({
  library: {
    metadataDir: 'fict-meta',
    packageJson: false,
  },
})
```

The retired root `fictMetadata` field and unversioned metadata are not consumed
by 0.31. See [Third-party Fict libraries](../../docs/third-party-libraries.md).

## Runtime behavior

- `__DEV__` is defined automatically from the Vite command/mode.
- Fict-transformed modules trigger a full reload during development so the
  generated reactive graph starts from a clean module instance.
- tsconfig changes reset the TypeScript project and transform cache.
- extracted Preview handlers keep compiler-provided source maps and explicit
  imports for captured module bindings.

For operational rollback, restore a complete 0.30.1 lockfile; see the
[compiler rollback runbook](../../docs/operations/runbooks/compiler-backend-rollback.md).
