# SSR Deployment Guide

This guide shows practical deployment patterns for Fict SSR.

> **Preview** — `@fictjs/ssr` is a **Satellite** package (independent versioning,
> not Core). `renderToString` / `renderToStream` / `renderToPipeableStream` are
> supported; **`renderToPartial`, resumability, and partial prerendering are
> Preview** (no semver, non-blocking for Core 1.0). See
> [SCOPE.md](../SCOPE.md) and [PREVIEW.md](./PREVIEW.md).

## 1) Runtime Selection Matrix

- Node runtime: `renderToPipeableStream` or `renderToStream`
- Edge runtime (Workers/Edge Functions): `renderToStream` (Web Streams)
- PPR workflow: `renderToPartial`

## 2) Node Deployment (Vercel Functions / traditional server)

```ts
import { renderToPipeableStream } from '@fictjs/ssr'

export default function handler(req, res) {
  const { pipe, shellReady, allReady } = renderToPipeableStream(() => <App url={req.url} />, {
    mode: 'shell',
    fullDocument: true,
    manifest: process.env.FICT_MANIFEST_PATH,
  })

  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  pipe(res)

  shellReady.catch(err => console.error('shell error', err))
  allReady.catch(err => console.error('stream error', err))
}
```

## 3) Vercel Edge / Cloudflare Workers (Web Streams)

```ts
import { renderToStream } from '@fictjs/ssr'

export default {
  async fetch(request: Request): Promise<Response> {
    const stream = renderToStream(() => <App url={new URL(request.url).pathname} />, {
      mode: 'shell',
      fullDocument: true,
      manifest: MANIFEST_OBJECT, // object form for edge
    })

    return new Response(stream, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        // Safe default for HTML that may contain user-specific snapshot state.
        'cache-control': 'private, no-store',
      },
    })
  },
}
```

## 4) Partial Prerendering Delivery Pattern

```ts
import { renderToPartial } from '@fictjs/ssr/experimental'

const partial = renderToPartial(() => <App />, { mode: 'shell', fullDocument: true })

// 1) Serve partial.shell as first response bytes or cache artifact
// 2) Stream partial.stream as deferred response body (or secondary channel)
```

Use this **Experimental Preview** API when you want static shell caching plus dynamic boundary resolution. Do not rely on the exact return shape as stable v1 API surface yet.

## 5) Manifest Handling

- Universal-safe: pass `manifest` as object.
- Path string (`manifest: '/path/to/fict.manifest.json'`) is a synchronous convenience for Deno deployments with `Deno.readTextFileSync` and Node CommonJS environments where `require('node:fs')` is available.
- In Node ESM and Edge runtimes, prefer object form loaded at startup/bundle-time.
- Manifest options are scoped to the active SSR render session. Concurrent or nested renders can use different manifest objects without overwriting `globalThis.__FICT_MANIFEST__`; the global manifest remains a non-SSR/client fallback.

The manifest is part of the executable build, not independent configuration.
Prefer a build-scoped URL such as `/builds/<build-id>/fict.manifest.json`. If a
fixed `/fict.manifest.json` is unavoidable, serve it with `no-store` or
mandatory revalidation. Do not use stale-while-revalidate for a fixed manifest:
old QRL mappings paired with new HTML or a new loader are not a compatible
state.

## 6) Atomic Build Contract

Deploy these artifacts as one compatibility unit:

1. SSR server bundle and its runtime dependencies.
2. HTML template and every embedded v2 snapshot.
3. Client loader/runtime entry.
4. `fict.manifest.json`.
5. Hashed QRL/handler and shared chunks.
6. External `fict-stream-runtime.js`, when used.
7. PPR shell and deferred patch producer.

Every request must resolve all seven from one build ID. PPR shells and deferred
patches must never cross a build or snapshot-schema boundary. Use build-scoped
asset/manifest URLs and request affinity, or purge cached shells before routing
their patches to a new server.

## 7) Cache Policy

| Artifact                              | Recommended policy                                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Hashed JS/QRL/stream-runtime assets   | `public, max-age=31536000, immutable`; retain old builds through the maximum HTML/SW TTL plus the server drain window           |
| Build-scoped manifest                 | Immutable with the rest of that build                                                                                           |
| Fixed-name manifest                   | `no-store` or `no-cache, must-revalidate`; never independent SWR                                                                |
| Personalized HTML or snapshot         | `private, no-store`                                                                                                             |
| Public, non-personalized SSR/PPR HTML | CDN caching only after review; cache key must include route, build ID, schema version, and every application-specific variation |
| ISR/PPR/KV/pre-rendered shell         | Store build/schema metadata and invalidate it as part of deployment                                                             |

Snapshot JSON is client-visible application data. A route is not safe for a
shared cache merely because the surrounding HTML looks static. Confirm that
the snapshot contains no user-specific or authorization-derived state before
using `public` caching.

Service workers must version HTML, manifests, and runtime assets together.
Activating a new worker must not combine an old cached document with a new
fixed-name manifest.

## 8) Schema Rollout And Rollback

For any snapshot schema or codec change:

1. Build and upload hashed client/QRL/stream assets first.
2. Upload the matching build-scoped manifest.
3. Deploy the SSR server pinned to that manifest and build ID.
4. Switch traffic, then purge CDN HTML, PPR/ISR output, KV/pre-rendered
   artifacts, and service-worker HTML/manifest caches.
5. Drain old server instances while retaining every asset their cached HTML can
   still reference.

Rollback is the reverse atomic operation: switch the server, manifest, loader,
and HTML build together, purge derived HTML/PPR caches again, and retain both
builds' hashed assets until their documents can no longer be served. Rolling
back only the server or only npm packages can leave v1/v2 HTML paired with the
wrong loader.

Explicit legacy migrations are a controlled bridge, not a substitute for cache
invalidation. Select `raw-props` or `encoded-props` only from known deployment
history; never infer the dialect from payload bytes.

## 9) Snapshot Rejection Fallback And Monitoring

Production resumable clients should configure both callbacks:

```ts
installResumableLoader({
  onSnapshotIssue: issue => report(issue, { buildId: BUILD_ID, route: location.pathname }),
  onSnapshotRejected: issue => mountClientRoot(issue),
})
```

This supported path does not emit resumability snapshots. Add
`includeSnapshot: true` only when deliberately adopting the Preview loader and
snapshot contract.

`onSnapshotRejected` runs after the loader disengages; the application owns the
CSR mount. Monitor issue code, build ID, schema version, route, and the server
build that produced the HTML. Alert separately on
`snapshot_unsupported_version`, `snapshot_migration_failed`, and
`snapshot_fallback_failed`.

## 10) Platform Notes

### Vercel

- Node Functions: use `renderToPipeableStream`.
- Edge Functions: use `renderToStream`.

### Cloudflare Workers

- Use `renderToStream`.
- Avoid Node-only APIs in request handler path.

### Deno Deploy

- Use `renderToStream`.
- File-path manifest works only when sync file APIs are available.

## 11) Production Checklist

- Correct runtime API chosen (pipeable vs web stream).
- `Content-Type` and cache headers set.
- Manifest loading strategy matches runtime constraints.
- SSR error logging wired (`onError`, promise catches).
- Snapshot inclusion reviewed (`includeSnapshot` true/false by route needs).
- Preview clients import `fict/experimental/loader`; no stable-looking loader
  subpath is deployed.
- Personalized snapshot HTML is `private, no-store`; any public cache key pins build/schema/route.
- Server, HTML, loader, manifest, QRL chunks, and stream runtime share one build ID.
- Schema rollout and rollback purge CDN, PPR/ISR, KV/pre-rendered, and service-worker caches.
- `onSnapshotIssue` telemetry and application-owned `onSnapshotRejected` CSR mount are wired.
- CSP strategy chosen: `scriptNonce` for generated scripts, or `streamRuntime: 'external'` with observer patch mode and the published `@fictjs/ssr/fict-stream-runtime.js` asset served from `streamRuntimeSrc`; nonce-free routes with Preview snapshots use `snapshotTarget: 'container'` or `'body'`.
- Legacy `exposeGlobals: true` routes run exclusively from every other SSR render; mixed or compatibility-mode overlap fails closed and should be observable through SSR error handling.
- Runtime matrix checked with `pnpm test:ssr-matrix`; manual Bun/Deno/host smoke results recorded when they apply.
