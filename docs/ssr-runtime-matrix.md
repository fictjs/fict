# SSR Runtime Matrix

This matrix is the release gate for production SSR, streaming, and resumability.

## Required Checks

Run the local matrix before an SSR/resume release:

```sh
pnpm test:ssr-matrix
```

The command runs:

- `@fictjs/ssr` Vitest suite for Node and Web Streams behavior.
- `@fictjs/ssr test:edge` smoke coverage for edge-compatible APIs.

## Platform Matrix

| Runtime                  | API                                                                            | Required coverage                                           | Status                        |
| ------------------------ | ------------------------------------------------------------------------------ | ----------------------------------------------------------- | ----------------------------- |
| Node 20+ HTTP/serverless | `renderToPipeableStream`, `renderToStream`, `renderToString`                   | Vitest SSR suite, pipeable stream tests, backpressure tests | Required                      |
| Web Streams edge runtime | `renderToStream`                                                               | `test:edge`, Web `ReadableStream` tests                     | Required                      |
| Vercel Node Functions    | `renderToPipeableStream`                                                       | Node matrix plus deployment manifest object/path review     | Required before v1.0          |
| Vercel Edge Functions    | `renderToStream`                                                               | Edge smoke plus object manifest review                      | Required before v1.0          |
| Cloudflare Workers       | `renderToStream`                                                               | Edge smoke, no Node globals in request path                 | Required before v1.0          |
| Bun server               | `renderToStream` first, pipeable only if Node stream compatibility is verified | Manual smoke until CI runner exists                         | Release-blocking manual check |
| Deno Deploy              | `renderToStream`                                                               | Manual smoke with object manifest                           | Release-blocking manual check |

## Release Gates

SSR/resume changes must satisfy these gates before being called production-ready:

1. CSP:
   - `scriptNonce` is applied to generated executable and JSON script tags.
   - Strict CSP routes can use `streamRuntime: 'external'` with observer patch mode and the published `@fictjs/ssr/fict-stream-runtime.js` asset.
2. Snapshot compatibility:
   - Unsupported versions fail closed.
   - Explicit `snapshotMigrations` cover any accepted older schema.
3. Hydration diagnostics:
   - Mismatched node/text claims are observable through `onHydrationIssue`.
4. Resumable loader recovery:
   - Import, missing export, missing resume registry, and thrown handler failures emit structured issues.
5. Concurrency:
   - SSR scope state and stream hooks are per render.
6. Streaming:
   - Web and Node writers respect pull/drain backpressure before continuing queued chunks.

## Manual Environment Notes

- Cloudflare/Vercel Edge must pass with manifest object form; filesystem manifest paths are not portable there.
- Bun and Deno checks are manual until dedicated CI runners exist. A release owner must record the runtime version and the smoke command used.
- Any platform that requires inline scripts must document its CSP policy. Prefer nonce or external runtime mode.
