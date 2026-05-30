# @fictjs/devtools

> **Internal distribution artifact:** per [SCOPE.md](../../SCOPE.md), this
> package is Changesets-ignored and feature-frozen. It exists for
> Fict-maintained browser/Vite tooling, not as a stable application dependency.

Fict DevTools for Vite development. This package provides:

- A Vite plugin that serves a standalone DevTools UI at `/__fict-devtools__/`
- Auto-injection of the DevTools hook (best-effort)

## Compatibility

Compatibility is governed by the DevTools hook protocol rather than the Core
release train. This package currently implements protocol `1` and supports
runtime hook protocol `1`.

At runtime, the installed hook exposes:

```ts
globalThis.__FICT_DEVTOOLS_HOOK__.devtools
```

The runtime ignores hooks that declare an incompatible protocol range.

## Vite usage (local/internal)

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
