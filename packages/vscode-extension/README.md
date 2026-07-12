# Fict for Visual Studio Code

The Fict extension adds compiler-aware reactivity diagnostics and navigation to Visual Studio
Code. It can explain reactive regions, preview compiled output, inspect component traces, and run
project health checks from the command palette.

The extension activates for JavaScript and TypeScript files, including JSX and TSX.

## Live trace

Live trace requires the Fict DevTools Vite plugin, which produces runtime line
updates and hosts the authenticated editor bridge:

```ts
import fictDevTools from '@fictjs/devtools/vite'

export default {
  plugins: [fictDevTools()],
}
```

Start Vite, then configure the workspace:

```json
{
  "fict.trace.mode": "live",
  "fict.dev.serverUrl": "http://localhost:5173",
  "fict.dev.tokenPath": ".fict-cache/devtools-token"
}
```

The Vite plugin creates the token when it starts and removes it on shutdown.
The path is resolved relative to the file's VS Code workspace folder. If the
Vite plugin uses a custom `liveTrace.tokenPath`, set the same path in VS Code.
