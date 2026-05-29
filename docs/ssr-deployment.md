# SSR Deployment Guide

This guide shows practical deployment patterns for Fict SSR.

> **Maturity:** `@fictjs/ssr` is a **Satellite** package (independent versioning,
> not Core) — see [SCOPE.md](../SCOPE.md). `renderToString` / `renderToStream` /
> `renderToPipeableStream` are supported; **`renderToPartial`, resumability, and
> partial prerendering are Preview** (no semver) — see [PREVIEW.md](./PREVIEW.md).

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
        'cache-control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=300',
      },
    })
  },
}
```

## 4) Partial Prerendering Delivery Pattern

```ts
import { renderToPartial } from '@fictjs/ssr'

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

## 6) Platform Notes

### Vercel

- Node Functions: use `renderToPipeableStream`.
- Edge Functions: use `renderToStream`.

### Cloudflare Workers

- Use `renderToStream`.
- Avoid Node-only APIs in request handler path.

### Deno Deploy

- Use `renderToStream`.
- File-path manifest works only when sync file APIs are available.

## 7) Production Checklist

- Correct runtime API chosen (pipeable vs web stream).
- `Content-Type` and cache headers set.
- Manifest loading strategy matches runtime constraints.
- SSR error logging wired (`onError`, promise catches).
- Snapshot inclusion reviewed (`includeSnapshot` true/false by route needs).
- CSP strategy chosen: `scriptNonce` for generated scripts, or `streamRuntime: 'external'` with observer patch mode and the published `@fictjs/ssr/fict-stream-runtime.js` asset served from `streamRuntimeSrc`.
- Runtime matrix checked with `pnpm test:ssr-matrix`; manual Bun/Deno/host smoke results recorded when they apply.
