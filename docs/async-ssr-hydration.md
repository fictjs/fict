# Async graph SSR and eager hydration

`$async` and `createAsyncMemo` use the same owned graph on the server and client.
An async JSX read registers its current generation with Suspense. Async string
rendering waits for readiness; shell streaming sends the fallback first and patches the
boundary when ready. A request owns its computations, cleanup, cancellation and
iterator lifetime. Disposing a request aborts its generations and ignores late
transport results. An async iterable contributes its first available value to
the response and is closed when that response is disposed.

Use `renderToStringAsync`, `renderToStream`, or `renderToPipeableStream` from
`@fictjs/ssr`. Synchronous `renderToString` retains its existing fallback behavior.
Keep request-specific computations inside the request's component/root. A
module-level computation intentionally has module lifetime and cannot provide
request isolation for per-user inputs.

## Client ownership

`hydrate` is a public Core export from `fict` and `@fictjs/runtime`:

```tsx
import { hydrate } from 'fict'
import { App } from './App'

const data = JSON.parse(document.getElementById('app-data')!.textContent!)
const stop = hydrate(
  () => <App input={data.value} request={() => fetch('/value').then(r => r.text())} />,
  document.getElementById('app')!,
  { strictHydration: true },
)

// When the view leaves, cancel its work and unmount its container.
stop()
```

The application supplies a JSON-safe initial data payload matching the server
view. Escape `<` as `\u003c` when embedding JSON in an HTML script element; raw
`JSON.stringify` output alone is not safe HTML embedding. This payload contains
application values, not Promises, pending tokens, controllers, functions, graph
nodes or request objects. Generations and subscriptions are created afresh by the
client. A client producer may initially return a pending Promise: Suspense parks
the claimed server content, displays fallback, and restores the same owned nodes
when its input resolves. Successful initial values should normally be seeded
synchronously to avoid a redundant request and fallback flash.

For a shell stream, complete parsing and application of the server patches
**before** calling `hydrate`. A document entry can wait for `DOMContentLoaded`
using a deferred/module script. A fragment-stream consumer must finish reading
and applying its stream before handing the container over. Hydrating while the
server is still replacing that range is not a supported ownership overlap.
Keep transport cancellation connected to the HTTP response's disconnect/abort
signal; the pipeable API exposes `abort`, and the readable API responds to reader
cancellation. No hydration step resumes JavaScript across a native `await`.

Ordinary SSR `<fict-host>` wrappers are transparent eager containers. They are
matched by position and their contents are hydrated; function names need not
survive independent server/client minification. Preview hosts with independent
resume entries keep their separate stable identity contract. Suspense,
ErrorBoundary and reactive child ranges claim their paired server markers.
Fragments retain connected DOM, including focus, user edits and selection.

`strictHydration: true` throws on reported structural/text/range mismatches and
releases attempted client ownership. ErrorBoundary does not convert that failure
into an application fallback. With the default repair mode,
`onHydrationIssue(issue)` can record repairs. Missing or damaged boundary ranges
are rebuilt within their owning hydration range. Server and client still need
compatible component structure and initial application data.

## Preview boundary

Keep `includeSnapshot: false`, the supported SSR default. Preview resumability
does not serialize async generations or transport ownership. The compiler rejects
Preview async declarations with `FICT-PREVIEW-ASYNC`; the runtime also rejects an
attempt to serialize compiler async slots through `includeSnapshot: true`.
This explicit application-data handoff is independent of the Preview snapshot ABI.

## Executable coverage

- `scripts/native-compiler-async-ssr.test.mjs`: native strict compilation through
  disabled/safe/full optimization, template/VNode SSR, generation ownership,
  cancellation, out-of-order requests, iterators, errors, minified eager hydration,
  initial client pending, namespace fallbacks and damaged ranges.
- `scripts/native-compiler-async-browser.test.mjs`: a real HTTP shell stream and
  Chromium, independently minified distributed client modules, two overlapping
  requests, node identity, refresh, error, unmount and HTTP disconnect.
- `packages/runtime/test/eager-hydration.test.ts`: fragment connection/focus,
  cleanup reentrancy, independent root options, strict errors, empty ranges and
  reactive updates after repair.
- `packages/ssr/test/async-runtime-contract.mjs`: the same graph/readiness and
  cancellation contract in isolated Node ESM, edge ESM and CommonJS smoke tests.

Run `pnpm test:compiler:native-runtime`, `pnpm test:ssr-matrix`, and
`pnpm test:async-ssr:browser`. Browser coverage is also included in the root
`pnpm test:e2e` CI/release gate. These are correctness and integration checks;
they do not establish a new CPU benchmark score.
