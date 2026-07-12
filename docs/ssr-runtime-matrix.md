# SSR Runtime Matrix

This matrix is the release gate for supported production SSR/streaming and for
the documented degradation behavior of Preview resumability. A green Preview
row does not graduate the feature and does not block Core 1.0.
The local automated gate is `pnpm test:ssr-matrix`; hosted platform rows track
external certification that release owners should record when publishing a
platform-specific deployment recipe.

## Required Checks

Run the local matrix before an SSR/resume release:

```sh
pnpm test:ssr-matrix
pnpm examples:verify
```

These commands run:

- `@fictjs/ssr` Vitest suite for Node and Web Streams behavior.
- `@fictjs/ssr test:edge` smoke coverage for edge-compatible APIs.
- `@fictjs/ssr test:cjs` smoke coverage for published CommonJS string,
  Web-stream, and pipeable-stream entrypoints, including abort settlement.
- Production builds for the maintained real-app, resumable SSR, and streaming
  examples.
- `examples/ssr-streaming` production smoke, which starts the built server,
  verifies streamed fallback HTML, waits for the deferred patch, and confirms
  the production process exits cleanly.

## Platform Matrix

| Runtime                     | API                                                                            | Required coverage                                           | Status                               |
| --------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------- | ------------------------------------ |
| Node 22.18+ HTTP/serverless | `renderToPipeableStream`, `renderToStream`, `renderToString`                   | Vitest SSR suite, pipeable stream tests, backpressure tests | Local automated gate                 |
| Web Streams edge runtime    | `renderToStream`                                                               | `test:edge`, Web `ReadableStream` tests                     | Local automated gate                 |
| Vercel Node Functions       | `renderToPipeableStream`                                                       | Node matrix plus deployment manifest object/path review     | External deployment certification    |
| Vercel Edge Functions       | `renderToStream`                                                               | Edge smoke plus object manifest review                      | External deployment certification    |
| Cloudflare Workers          | `renderToStream`                                                               | Edge smoke, no Node globals in request path                 | External deployment certification    |
| Bun server                  | `renderToStream` first, pipeable only if Node stream compatibility is verified | Manual smoke until CI runner exists                         | Optional compatibility certification |
| Deno Deploy                 | `renderToStream`                                                               | Manual smoke with object manifest                           | Optional compatibility certification |

## Release Gates

SSR/resume changes must satisfy these local gates before the supported SSR
surface is called production-ready. These gates do not graduate Preview APIs;
Preview graduation still follows [PREVIEW.md](./PREVIEW.md).

1. CSP:
   - `scriptNonce` is applied to generated executable and JSON script tags.
   - Strict CSP routes can use `streamRuntime: 'external'` with observer patch mode and the published `@fictjs/ssr/fict-stream-runtime.js` asset.
   - Trusted Types routes should use the external observer runtime; a sink regression test forbids `innerHTML`, `insertAdjacentHTML`, `eval`, and `Function`.
2. Snapshot compatibility:
   - SSR writers emit v2.
   - Missing `v` and ambiguous v1 payloads fail closed by default.
   - `raw-props`, `encoded-props`, and unversioned-sentinel migrations are
     covered independently; no format heuristic is permitted.
3. Hydration diagnostics:
   - Mismatched node/text claims are observable through `onHydrationIssue`.
   - `strictHydration: true` turns hydration mismatches into thrown errors after reporting the issue.
4. Resumable loader recovery:
   - `onSnapshotRejected` runs once after loader cleanup and hands control to an
     application-owned CSR mount.
   - Async fallback failure emits `snapshot_fallback_failed` without an
     unhandled rejection.
   - Import, missing export, missing resume registry, and thrown handler failures emit structured issues.
   - QRL failures are no-ops after reporting; no ErrorBoundary or automatic CSR
     routing is claimed.
5. Concurrency:
   - SSR scope state and stream hooks are per render.
   - DOM globals are not exposed by default; `exposeGlobals: true` is a legacy compatibility mode and is not concurrency-safe for overlapping renders.
6. Streaming:
   - Web and Node writers respect pull/drain backpressure before continuing queued chunks.
   - `pnpm examples:verify` proves the built streaming example serves shell and
     deferred patch output through its production server path.
7. Deployment compatibility:
   - SSR HTML/snapshot, loader, manifest, QRL chunks, PPR patches, and external
     stream runtime are pinned to one build.
   - Snapshot schema changes have an atomic rollout/rollback and cache-purge
     plan covering CDN, PPR/ISR, KV/pre-rendered, and service-worker caches.

## External Certification Notes

- Cloudflare/Vercel Edge must pass with manifest object form; filesystem manifest paths are not portable there.
- Bun and Deno checks are manual until dedicated CI runners exist. A release owner should record the runtime version and the smoke command used before publishing first-class deployment guidance for those hosts.
- Any platform that requires inline scripts must document its CSP policy. Prefer nonce or external runtime mode.
- Hosted certification must record the build-ID strategy, fixed-manifest cache
  policy, hashed-asset retention window, and schema rollback drill.

## Verification Paths

- `packages/runtime/test/resume-lifecycle.test.ts`: v2 writer and state validation.
- `packages/runtime/test/loader.test.ts`: missing/v1 rejection, both legacy
  dialects, sentinel migration, one-shot CSR handoff, and fallback failure.
- `packages/ssr/test/e2e-resumable.test.ts`: rendered SSR snapshot rejection to
  application-owned client render.
- `packages/ssr/test/streaming.test.ts`: streaming, CSP, Trusted Types,
  backpressure, and downstream failure.
