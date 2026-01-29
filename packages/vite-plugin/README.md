# @fictjs/vite-plugin

![Node CI](https://github.com/fictjs/fict/workflows/CI/badge.svg)
![npm](https://img.shields.io/npm/v/fict.svg)
![license](https://img.shields.io/npm/l/fict)

Vite plugin for Fict

## Usage

```bash
npm install -D @fictjs/vite-plugin
# or
yarn add -D @fictjs/vite-plugin
```

You can visit [Fict](https://github.com/fictjs/fict) for more documentation.

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
      // Allow $state/$effect inside reactive-scope callbacks (e.g., renderHook(() => ...))
      reactiveScopes: ['renderHook'],
    }),
  ],
})
```

Notes:

- `reactiveScopes` only applies to **direct calls** and only treats the **first argument** as the reactive callback.
- Aliased/indirect calls are not recognized (e.g., `const rh = renderHook; rh(() => ...)`).
