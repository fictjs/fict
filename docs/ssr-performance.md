# SSR Performance Tuning

This guide focuses on practical SSR tuning for Fict apps.

> **Maturity:** `@fictjs/ssr` is a **Satellite** package (see [SCOPE.md](../SCOPE.md)).
> `renderToString` / `renderToStream` / `renderToPipeableStream` are supported;
> **`renderToPartial` / partial prerendering are Preview** ([PREVIEW.md](./PREVIEW.md)).

## 1) Choose the Right Render Mode

- `renderToString`: simplest, one-shot HTML.
- `renderToStream({ mode: 'shell' })`: best TTFB; stream fallback shell first.
- `renderToStream({ mode: 'all' })`: complete HTML only after all Suspense resolves.
- `renderToPartial`: experimental static-first shell + deferred patch stream (PPR-style).

Rule of thumb:

- user-facing routes: `shell` or `partial`
- bots/internal export routes: sometimes `all`

## 2) Keep Snapshot Small

Snapshot size directly affects network cost and parse time.

### Prefer IDs over large payloads

```tsx
// heavy snapshot
let productList = $state(serverPayload)

// lean snapshot
let productIds = $state(serverPayload.map(p => p.id))
```

### Keep ephemeral data out of resumable state

- avoid storing large transient arrays/maps in top-level reactive state
- compute on server and serialize only what client must resume

### Disable snapshot when resumability is unnecessary

```ts
renderToString(view, { includeSnapshot: false })
```

## 3) Shape Suspense Boundaries Deliberately

Too coarse:

- one boundary blocks too much content

Too fine:

- too many patch chunks and scripts

Target:

- one stable boundary per major async island (hero, recommendations, comments, etc.)

## 4) Reduce HTML/Chunk Size

- enable Brotli/Gzip at CDN/edge
- minify production HTML template wrappers
- avoid overly verbose inline JSON in props/state

## 5) Cache Strategy

### For shell-first / partial

- cache only public, non-personalized shells whose cache key pins the route,
  build ID, and snapshot schema
- keep every deferred patch on the same build/schema as its shell
- retain hashed loader and QRL assets for at least the maximum shell and
  service-worker TTL

### For mostly static routes

- pre-render once and serve from edge cache only when the embedded snapshot has
  no user-specific or authorization-derived data

### For personalized routes

- use `private, no-store` for HTML containing personalized snapshot state
- never let a fixed-name manifest use stale-while-revalidate independently
  from the HTML

Cache correctness is part of resumability correctness: an old shell paired with
a new loader, manifest, or patch stream can reject its snapshot or load the
wrong QRL. Follow the atomic rollout, purge, and rollback procedure in the
[SSR Deployment Guide](./ssr-deployment.md).

## 6) Runtime Cost on Server

- avoid expensive synchronous work in component render path
- move heavy transforms to build time or data layer
- memoize route-level data fetches during a request when safe

## 7) Measure the Right Metrics

- server render latency (p50/p95)
- TTFB
- FCP/LCP
- HTML bytes (compressed and uncompressed)
- snapshot bytes

Track per route, not just global averages.

## 8) Quick Snapshot Audit Script

```ts
function getSnapshotBytes(doc: Document): number {
  const scripts = doc.querySelectorAll('script[data-fict-snapshot],#__FICT_SNAPSHOT__')
  let bytes = 0
  for (const script of scripts) {
    bytes += new TextEncoder().encode(script.textContent ?? '').length
  }
  return bytes
}
```

## 9) Optimization Checklist

- Correct mode selected per route (`string` / `shell` / `all` / `partial`)
- Snapshot payload reviewed and bounded
- Suspense boundaries map to real async islands
- Compression enabled
- CDN cache policy verified
- HTML, manifest, loader, QRL chunks, and PPR patches pinned to one build ID
- Schema changes purge CDN/PPR/ISR/KV/pre-rendered/service-worker document caches
- Route-level metrics dashboard in place
