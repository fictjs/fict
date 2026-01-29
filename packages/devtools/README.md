# @fictjs/devtools

Fict DevTools for Vite development. This package provides:

- A Vite plugin that serves a standalone DevTools UI at `/_ _fict-devtools__/`
- Auto-injection of the DevTools hook (best-effort)

## Vite usage

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import { fictDevTools } from '@fictjs/devtools'

export default defineConfig({
  plugins: [fictDevTools()],
})
```

## Auto-injection (best-effort)

The plugin tries to auto-inject the DevTools hook into your entry file.
This is heuristic-based and may not match every project structure.

If auto-injection doesn't happen, add this line to your entry file:

```ts
import 'virtual:fict-devtools'
```

The dev server logs a warning when it sees render calls but can't
confidently find a DOM mount reference.
