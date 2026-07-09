# @fictjs/vite-plugin

![Node CI](https://github.com/fictjs/fict/workflows/CI/badge.svg)
![npm](https://img.shields.io/npm/v/fict.svg)
![license](https://img.shields.io/npm/l/fict)

Vite plugin for Fict

## Usage

```bash
npm install fict
npm install -D @fictjs/vite-plugin
# or
yarn add fict
yarn add -D @fictjs/vite-plugin
```

You can visit [Fict](https://github.com/fictjs/fict) for more documentation.

Use `fict` as the runtime dependency for standard Fict apps. If you intentionally build directly on `@fictjs/runtime`, keep your source imports on that package family consistently.

## Options

```ts
import fict from '@fictjs/vite-plugin'

export default defineConfig({
  plugins: [
    fict({
      // Optional transform cache (memory + persistent disk cache)
      cache: { persistent: true },
      // Optional TypeScript project integration
      useTypeScriptProject: true,
      tsconfigPath: './tsconfig.json',
      // Optional plugin debug logs (or set FICT_VITE_PLUGIN_DEBUG=1)
      debug: false,
      // Allow $state/$effect inside reactive-scope callbacks (e.g., renderHook(() => ...))
      reactiveScopes: ['renderHook'],
    }),
  ],
})
```

Core defaults:

- `include`: `['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs', '**/*.mts', '**/*.cts']`
- TypeScript declaration files (`.d.ts`, `.d.mts`, `.d.cts`) are never transformed.
- `exclude`: `['**/node_modules/**']`
- `useTypeScriptProject`: `true`
- `cache`:
  - enabled by default
  - memory cache always on
  - persistent cache defaults to `true` during `vite build`, otherwise in-memory only

## Library Publishing

Use `library: true` when building a third-party Fict hook library with Vite library mode:

```ts
import { defineConfig } from 'vite'
import fict from '@fictjs/vite-plugin'

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

- compiles `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts`, and `.cts` source by default;
- collects compiler-generated module metadata from transformed entry chunks;
- emits `*.fict.meta.json` files into the build output;
- updates the package `package.json` with `fict.metadata` for one public entry or `fict.exports` for multiple public entries.
- warns when a public entry emits no Fict metadata and fails package declaration writing when generated metadata cannot be mapped to `exports`, `module`, or `main`.

The package mapping is inferred from existing `package.json#exports`, `module`, and `main` fields. For example:

```json
{
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    },
    "./hooks": "./dist/hooks.js"
  }
}
```

after `vite build` becomes:

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

Options:

```ts
fict({
  library: {
    // Emit metadata files under dist/fict-meta instead of next to each entry chunk.
    metadataDir: 'fict-meta',
    // Set false when another release script owns package.json mutation.
    packageJson: false,
  },
})
```

Compiler option passthrough:

- This plugin forwards compiler options directly (for example: `strictGuarantee`, `strictReactivity`, `lazyConditional`, `emitModuleMetadata`, `warningLevels`, `reactiveScopes`).
- Current compiler default is `strictGuarantee: true` (fail-closed).
- Production builds force-enable `strictGuarantee` when `NODE_ENV=production`; use opt-out profiles only outside production.

Runtime dev/prod define:

- The plugin defines `__DEV__` automatically:
  - `true` in dev server
  - `false` in production build

HMR behavior:

- Fict-transformed source modules intentionally trigger a full reload in dev so the compiler-generated reactive graph is rebuilt from a clean module instance.
- `tsconfig` changes reset the TypeScript project and transform cache before the next transform.
- See `docs/tooling-runtime-matrix.md` for the v1.0 tooling release gate.

Function splitting:

- Production builds extract compiler-generated event handlers into virtual handler modules when `functionSplitting` is enabled.
- Runtime helper imports in those virtual modules are self-contained and use the same package family as the source module (`fict` or `@fictjs/runtime`).
- If an extracted handler closes over a module-local helper, component, constant, or import, the source module keeps that binding and re-exports it under a generated private `__fict_dep_` name. The virtual handler imports that private dependency from the source module.
- Because of that local dependency contract, handler chunks are not always fully independent from their source module. A handler with no module-local dependencies can split at handler granularity; a handler with local dependencies may load the source module when the handler chunk runs.

Recommended profiles:

```ts
// Strict app/CI baseline
fict({
  strictGuarantee: true,
})

// Non-production migration / benchmark compatibility
fict({
  strictGuarantee: false,
  emitModuleMetadata: false,
  dev: false,
})
```

Notes:

- `reactiveScopes` only applies to **direct calls** and only treats the **first argument** as the reactive callback.
- Aliased/indirect calls are not recognized (e.g., `const rh = renderHook; rh(() => ...)`).
- Cross-module metadata lookup is filesystem-based (relative/absolute/alias/ts resolution). Bare package imports can opt in by publishing `fict.metadata` or `fict.exports` in `package.json`; see `docs/third-party-libraries.md`.
- `debug` logs are disabled by default; enable with `debug: true` or `FICT_VITE_PLUGIN_DEBUG=1`.
