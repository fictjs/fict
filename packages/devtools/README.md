# @fictjs/devtools

> **Internal distribution artifact:** per [SCOPE.md](../../SCOPE.md), this
> package is Changesets-ignored and feature-frozen. It exists for
> Fict-maintained browser/Vite tooling, not as a stable application dependency.

Fict DevTools for Vite development. This package provides:

- A Vite plugin that serves a standalone DevTools UI at `/__fict-devtools__/`
- Auto-injection of the DevTools hook (best-effort)
- An authenticated runtime-to-editor live trace bridge at `/__fict-trace__`

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
import fictDevTools from '@fictjs/devtools/vite'

export default defineConfig({
  plugins: [fictDevTools()],
})
```

The plugin serves the panel on the Vite origin and starts a launcher at
`http://127.0.0.1:5175/`; its embedded panel remains on the Vite origin so the
runtime transport keeps working. Public Vite options are applied as follows:

```ts
fictDevTools({
  port: 5180,
  openInBrowser: true,
  openInEditor: {
    // The Vite root is always allowed; opt in linked source roots explicitly.
    additionalRoots: ['../shared-ui'],
  },
  componentNameTransformer: name => `MyApp/${name}`,
})
```

- `port` selects the standalone launcher port (`0` requests an available port).
- `openInBrowser` opens the launcher and reports launch failures through the
  Vite logger.
- `openInEditor` is protected by a per-server token and same-origin POST check.
  It accepts files under the Vite root by default. Add trusted monorepo or linked
  source directories through `additionalRoots`, or set it to `false` to disable
  the endpoint.
- `componentNameTransformer` runs inside the browser before the debugger is
  attached. It must be a synchronous, self-contained function and cannot
  capture variables from `vite.config.ts`.

## VS Code live trace

The Vite plugin writes an ephemeral bearer token to
`.fict-cache/devtools-token` and removes the file when the server stops. In VS
Code, set `fict.trace.mode` to `live` and `fict.dev.serverUrl` to the Vite
origin (for example, `http://localhost:5173`). The extension reads the token
from `fict.dev.tokenPath` and subscribes only to the active source file.

To use a different token location, configure both sides with the same path:

```ts
fictDevTools({
  liveTrace: { tokenPath: '.cache/fict-live-trace-token' },
})
```

The token grants access to local runtime telemetry. Keep its directory out of
source control and do not share the token.

## Auto-injection (best-effort)

The plugin tries to auto-inject the DevTools hook into your entry file.
This is heuristic-based and may not match every project structure.

If auto-injection doesn't happen, add this line to your entry file:

```ts
import 'virtual:fict-devtools'
```

The dev server logs a warning when it sees render calls but can't
confidently find a DOM mount reference.
