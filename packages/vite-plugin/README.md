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

- `include`: `['**/*.tsx', '**/*.jsx']`
  - with `library: true`: `['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx']`
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

- compiles `.ts`, `.tsx`, `.js`, and `.jsx` source by default;
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

Runtime dev/prod define:

- The plugin defines `__DEV__` automatically:
  - `true` in dev server
  - `false` in production build

Recommended profiles:

```ts
// Strict app/CI baseline
fict({
  strictGuarantee: true,
})

// Migration / benchmark compatibility
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
