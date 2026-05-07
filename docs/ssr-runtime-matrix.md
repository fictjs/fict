# SSR Runtime Matrix

This matrix is the release gate for production SSR, streaming, and resumability.
The local automated gate is `pnpm test:ssr-matrix`; hosted platform rows track
external certification that release owners should record when publishing a
platform-specific deployment recipe.

## Required Checks

Run the local matrix before an SSR/resume release:

```sh
pnpm test:ssr-matrix
```

The command runs:

- `@fictjs/ssr` Vitest suite for Node and Web Streams behavior.
- `@fictjs/ssr test:edge` smoke coverage for edge-compatible APIs.

## Platform Matrix

| Runtime                  | API                                                                            | Required coverage                                           | Status                               |
| ------------------------ | ------------------------------------------------------------------------------ | ----------------------------------------------------------- | ------------------------------------ |
| Node 20+ HTTP/serverless | `renderToPipeableStream`, `renderToStream`, `renderToString`                   | Vitest SSR suite, pipeable stream tests, backpressure tests | Local automated gate                 |
| Web Streams edge runtime | `renderToStream`                                                               | `test:edge`, Web `ReadableStream` tests                     | Local automated gate                 |
| Vercel Node Functions    | `renderToPipeableStream`                                                       | Node matrix plus deployment manifest object/path review     | External deployment certification    |
| Vercel Edge Functions    | `renderToStream`                                                               | Edge smoke plus object manifest review                      | External deployment certification    |
| Cloudflare Workers       | `renderToStream`                                                               | Edge smoke, no Node globals in request path                 | External deployment certification    |
| Bun server               | `renderToStream` first, pipeable only if Node stream compatibility is verified | Manual smoke until CI runner exists                         | Optional compatibility certification |
| Deno Deploy              | `renderToStream`                                                               | Manual smoke with object manifest                           | Optional compatibility certification |

## Release Gates

SSR/resume changes must satisfy these local gates before the core package is
called production-ready:

1. CSP:
   - `scriptNonce` is applied to generated executable and JSON script tags.
   - Strict CSP routes can use `streamRuntime: 'external'` with observer patch mode and the published `@fictjs/ssr/fict-stream-runtime.js` asset.
   - Trusted Types routes should use the external observer runtime; a sink regression test forbids `innerHTML`, `insertAdjacentHTML`, `eval`, and `Function`.
2. Snapshot compatibility:
   - Unsupported versions fail closed.
   - Explicit `snapshotMigrations` cover any accepted older schema.
3. Hydration diagnostics:
   - Mismatched node/text claims are observable through `onHydrationIssue`.
   - `strictHydration: true` turns hydration mismatches into thrown errors after reporting the issue.
4. Resumable loader recovery:
   - Import, missing export, missing resume registry, and thrown handler failures emit structured issues.
5. Concurrency:
   - SSR scope state and stream hooks are per render.
   - DOM globals are not exposed by default; `exposeGlobals: true` is a legacy compatibility mode and is not concurrency-safe for overlapping renders.
6. Streaming:
   - Web and Node writers respect pull/drain backpressure before continuing queued chunks.

## External Certification Notes

- Cloudflare/Vercel Edge must pass with manifest object form; filesystem manifest paths are not portable there.
- Bun and Deno checks are manual until dedicated CI runners exist. A release owner should record the runtime version and the smoke command used before publishing first-class deployment guidance for those hosts.
- Any platform that requires inline scripts must document its CSP policy. Prefer nonce or external runtime mode.
