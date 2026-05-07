# Tooling Runtime Matrix

This matrix is the release gate for Fict build-tool integration outside the core
compiler/runtime packages.

## Required Checks

Run the local tooling matrix before calling a release production-ready:

```sh
pnpm test:bundlers
pnpm --dir packages/vite-plugin test
```

The command set covers:

- Vite plugin transform, cache, function-splitting, sourcemap, and metadata behavior.
- Webpack example build (`examples/counter-webpack`).
- Basic Vite example build (`examples/counter-basic`).

## Bundler Matrix

| Tooling path        | Required coverage                                          | Status         |
| ------------------- | ---------------------------------------------------------- | -------------- |
| Vite dev server     | Plugin transform tests and explicit HMR contract below     | Required       |
| Vite production app | Plugin tests plus `examples/counter-basic` build           | Required       |
| Vite library mode   | Metadata emission, package declaration, and fingerprinting | Required       |
| Webpack app example | `examples/counter-webpack` production build                | Required       |
| Other bundlers      | Use Babel preset/compiler directly; no release gate yet    | Not guaranteed |

## HMR Contract

Fict's Vite plugin intentionally sends a full reload for transformed `.tsx` and
`.jsx` modules during dev. This is the supported v1.0 behavior because the
compiler builds a reactive graph at transform time; accepting granular HMR would
need graph patching and lifecycle reconciliation that is not part of the current
contract.

Required behavior:

1. `tsconfig` changes reset the TypeScript project and transform cache.
2. Fict-transformed source changes send `server.ws.send({ type: 'full-reload', path: '*' })`.
3. Non-transformed files are left to Vite's default HMR pipeline.

## Function-Splitting and Sourcemap Contract

Function splitting must preserve sourcemaps for the main transformed module and
must emit stable virtual modules for extracted handlers. Release candidates must
keep the Vite plugin function-splitting tests green before claiming support.

## Strict CSP and Trusted Types Contract

Fict SSR does not require `innerHTML` or `eval` in its streaming patch runtime.
For deployments enforcing strict CSP or `require-trusted-types-for 'script'`, use
external observer mode instead of inline patch scripts:

```ts
renderToStream(() => <App />, {
  mode: 'shell',
  streamRuntime: 'external',
  streamRuntimeSrc: '/assets/fict-stream-runtime.js',
  streamPatchMode: 'observer',
})
```

Snapshot payloads are emitted as `application/json` script tags and inserted with
`textContent` for head-target incremental snapshots. If a host application wraps
HTML delivery in a Trusted Types policy, the policy should cover the complete
server-rendered HTML document; Fict does not currently create or require a
browser-side Trusted Types policy of its own.

## Release Gates

Before claiming v1.0 tooling readiness:

1. Run `pnpm test:bundlers`.
2. Run `pnpm --dir packages/vite-plugin test`.
3. Verify Vite HMR still performs full reloads for transformed source modules.
4. Verify strict CSP routes use `streamRuntime: 'external'` when inline scripts
   are disallowed.
