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
- `exclude`: `['**/node_modules/**']`
- `useTypeScriptProject`: `true`
- `cache`:
  - enabled by default
  - memory cache always on
  - persistent cache defaults to `true` during `vite build`, otherwise in-memory only

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
- Cross-module metadata lookup is filesystem-based (relative/absolute/alias/ts resolution). Bare package imports require a custom `resolveModuleMetadata` hook if you need metadata propagation.
- `debug` logs are disabled by default; enable with `debug: true` or `FICT_VITE_PLUGIN_DEBUG=1`.
