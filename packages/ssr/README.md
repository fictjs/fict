# @fictjs/ssr

Fict's Satellite Server-Side Rendering (SSR) package, providing supported
string and streaming rendering plus opt-in client resumability.

> **Preview** — resumability, snapshot schema v2, and partial prerendering have no
> semver guarantee and are excluded from Core 1.0. They require
> `includeSnapshot: true`, compiler `resumable: true`, and the
> `fict/experimental/loader` entrypoint. Basic string and streaming SSR does not
> enable them by default.

## Table of Contents

- [Overview](#overview)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Core Concepts](#core-concepts)
- [API Reference](#api-reference)
- [Architecture Design](#architecture-design)
- [Partial Prerendering](#partial-prerendering)
- [Edge Runtime](#edge-runtime)
- [Integration with Vite](#integration-with-vite)
- [Advanced Usage](#advanced-usage)
- [Performance Optimization](#performance-optimization)
- [Production Guides](#production-guides)
- [Troubleshooting](#troubleshooting)

## Overview

Supported SSR produces HTML without a resumability snapshot by default. The
optional **Preview Resumability** architecture is fundamentally different from
traditional hydration:

| Feature                   | Traditional Hydration             | Fict Resumability                 |
| ------------------------- | --------------------------------- | --------------------------------- |
| Client JS Execution       | Re-executes entire component tree | Only executes on interaction      |
| Time to Interactive (TTI) | High (waits for hydration)        | Low (Zero JS execution)           |
| Handler Loading           | All preloaded                     | Lazy loaded on demand             |
| State Restoration         | Re-calculated                     | Restored from serialized snapshot |

### How Preview Resumability Works

```
┌─────────────────────────────────────────────────────────────────┐
│                      Server-Side Rendering                      │
├─────────────────────────────────────────────────────────────────┤
│  1. Execute component code                                      │
│  2. Generate HTML + Serialize state snapshot                    │
│  3. Inject QRL (Qualified Resource Locator) references          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Client-Side Resumability                   │
├─────────────────────────────────────────────────────────────────┤
│  1. Parse snapshot, store in memory                             │
│  2. Install event delegation listeners                          │
│  3. On user interaction:                                        │
│     a. Lazy load handler chunk                                  │
│     b. Restore component state (from snapshot)                  │
│     c. Establish reactive bindings                              │
│     d. Execute handler                                          │
└─────────────────────────────────────────────────────────────────┘
```

## Installation

```bash
pnpm add fict @fictjs/ssr
```

## Quick Start

### Basic SSR

```typescript
import { renderToString } from '@fictjs/ssr'
import { App } from './App'

// Server-side
const html = renderToString(() => <App />)
```

### SSR with Resumability

```typescript
import { renderToString } from '@fictjs/ssr'
import { App } from './App'

const html = renderToString(() => <App />, {
  includeSnapshot: true, // Explicit Preview snapshot opt-in (default false)
  containerId: 'app',
  manifest: './dist/client/fict.manifest.json',
})
```

### Client-Side Resumability

```typescript
// entry-client.tsx
import { render } from 'fict'
import { installResumableLoader } from 'fict/experimental/loader'
import { App } from './App'

// Load manifest (production)
async function loadManifest() {
  // Prefer a build-scoped URL. If the manifest has a fixed name, revalidate it
  // instead of allowing it to become stale independently from the HTML.
  const res = await fetch('/fict.manifest.json', { cache: 'no-store' })
  if (res.ok) {
    globalThis.__FICT_MANIFEST__ = await res.json()
  }
}

async function init() {
  await loadManifest()

  installResumableLoader({
    events: ['click', 'input', 'change', 'submit'],
    onSnapshotIssue: issue => reportSnapshotIssue(issue),
    onSnapshotRejected: () => {
      const root = document.getElementById('app')!
      root.replaceChildren()
      render(() => <App />, root)
    },
    prefetch: {
      visibility: true,
      visibilityMargin: '200px',
      hover: true,
      hoverDelay: 50,
    },
  })
}

init()
```

## Core Concepts

### 1. QRL (Qualified Resource Locator)

QRL is the URL format Fict uses for lazy loading handlers:

```
virtual:fict-handler:h0123456789abcdef0123456789abcdef$$__fict_e0#default
│                    │                                  │         │
│                    │                                  │         └─ Export Name
│                    │                                  └─ Handler Export
│                    └─ Opaque Source Identity
└─ Virtual Module Prefix
```

Production identities are checkout-independent and do not contain source paths.

**Representation in HTML:**

```html
<button on:click="virtual:fict-handler:h0123456789abcdef0123456789abcdef$$__fict_e0#default">
  Click me
</button>
```

### 2. State Snapshot

During server-side rendering, component state is serialized into JSON and injected into HTML:

```html
<script id="__FICT_SNAPSHOT__" type="application/json">
  {
    "v": 2,
    "scopes": {
      "account_scope:s1": {
        "id": "account_scope:s1",
        "slots": [
          [0, "sig", 10],      // Index 0: signal, value 10
          [1, "store", {...}], // Index 1: store
          [2, "raw", null]     // Index 2: raw value
        ],
        "vars": { "count": 0 }
      }
    }
  }
</script>
```

**Supported Serialization Types:**

| Type / shape                  | Tag                         | Preserved detail                                  |
| ----------------------------- | --------------------------- | ------------------------------------------------- |
| Date                          | `__t: 'd'`                  | Timestamp or invalid-date marker                  |
| Map / Set                     | `__t: 'm'` / `__t: 's'`     | Recursively encoded entries/items                 |
| RegExp                        | `__t: 'r'`                  | Source, flags, and `lastIndex`                    |
| Global/well-known Symbol      | `__t: 'sym'`                | Symbol registry kind and name                     |
| Special object representation | `__t: 'o'`                  | Symbol keys, null prototype, or literal `__t` key |
| Array hole                    | `__t: 'h'`                  | Distinguishes a hole from `undefined`             |
| undefined / NaN / negative 0  | `__t: 'u'` / `'n'` / `'-0'` | Values JSON cannot represent faithfully           |
| Infinity                      | `__t: '+i'` / `__t: '-i'`   | Positive/negative infinity                        |
| BigInt                        | `__t: 'b'`                  | Decimal string                                    |
| Shared/circular reference     | `__t: 'ref'`                | Path to an already encoded object                 |

Schema v2 escapes plain objects that themselves contain `__t`, so literal user
data cannot be confused with a serialization marker. Unsupported object shapes
and functions stored inside value-bearing containers fail serialization rather
than being silently corrupted. Function-valued component-prop properties and
function-valued raw slots are intentionally omitted by the existing compiler
ABI.

### 3. Scope Registration

Each resumable component instance has a unique scope ID:

```html
<fict-host
  data-fict-s="account_scope:s1"                      <!-- scope ID -->
  data-fict-h="/assets/index.js#__fict_r0"            <!-- resume handler -->
  data-fict-t="Counter@fict:module:m0123456789abcdef0123456789abcdef" <!-- Component Type -->
>
  ...
</fict-host>
```

Every SSR render receives an automatic unique namespace for these host and
snapshot scope IDs. For deterministic cached output, or when fragments from
multiple services can share a document, pass a stable `scopeIdentifierPrefix`
that is unique within the final document:

```typescript
renderToString(() => <App />, {
  scopeIdentifierPrefix: 'account_scope',
})
```

This option is shared by string, document, Web Stream, pipeable, async-string,
and partial render entry points. It does not affect Suspense patch IDs; use
`streamIdentifierPrefix` for those. Reusing a scope prefix in one document can
make loader state ambiguous. Prefixes accept 1-128 ASCII letters, digits, `_`,
`.`, `:`, or `-`, but may not contain `--`.

### 4. Automatic Handler Extraction

The Fict compiler supports two ways to extract handlers:

**Explicit Extraction (using `$` suffix):**

```tsx
<button onClick$={() => count++}>  // Always extracted
```

**Automatic Extraction (enable `autoExtractHandlers`):**

```tsx
<button onClick={() => count++}>       // Simple, might not extract
<button onClick={() => fetchData()}>   // Complex, auto-extracted
<button onClick={handleSubmit}>        // External reference, auto-extracted
```

**Heuristic Rules for Auto-Extraction:**

| Condition                   | Extracted? |
| --------------------------- | ---------- |
| External function reference | ✅         |
| Contains external calls     | ✅         |
| Contains async/await        | ✅         |
| AST node count ≥ threshold  | ✅         |
| Simple expression           | ❌         |

## API Reference

### renderToString

```typescript
function renderToString(view: () => FictNode, options?: RenderToStringOptions): string
```

**Options:**

```typescript
interface RenderToStringOptions {
  // DOM Configuration
  dom?: SSRDom
  document?: Document
  window?: Window
  html?: string

  // Container Configuration
  container?: HTMLElement
  containerTag?: string // Default: 'div'
  containerId?: string
  containerAttributes?: Record<string, string | number | boolean>

  // Output Configuration
  includeContainer?: boolean // Include container tag
  fullDocument?: boolean // Output full HTML document
  doctype?: string | null

  // Resumability Configuration
  includeSnapshot?: boolean // Preview opt-in; default: false
  snapshotScriptId?: string // Default: '__FICT_SNAPSHOT__'
  snapshotTarget?: 'container' | 'body' | 'head'

  // Runtime Configuration
  exposeGlobals?: boolean // Default: false; opt-in compatibility mode
  manifest?: Record<string, string> | string
}
```

By default SSR does not write `window`, `document`, `Node`, or related DOM constructors to
`globalThis`. This keeps concurrent renders from racing over process-global DOM state. Components
should use Fict's render-provided document/ownerDocument paths; set `exposeGlobals: true` only for
legacy code that still reads DOM globals during server render. That compatibility mode is restored
on `dispose()`. Nested or overlapping compatibility renders are rejected before they can replace
the active render's globals.

### renderToStringAsync

```typescript
function renderToStringAsync(view: () => FictNode, options?: RenderToStringOptions): Promise<string>
```

Waits until all Suspense boundaries have resolved, then serializes their final content. Its output
options and defaults match `renderToString`; in particular, it returns the rendered container's
children unless `fullDocument` or `includeContainer` is requested. Use `renderToString` when a
synchronous fallback shell is desired instead.

### renderToDocument

```typescript
function renderToDocument(
  view: () => FictNode,
  options?: RenderToStringOptions,
): RenderToDocumentResult

interface RenderToDocumentResult extends SSRDom {
  html: string
  container: HTMLElement
  dispose: () => void
}
```

Returns a DOM object for further manipulation or streaming rendering.

### renderToStream

Stream HTML to a Web `ReadableStream`. In `shell` mode, the fallback shell is
sent immediately and Suspense boundaries patch in as they resolve.

> Note: In `shell` mode, resumable snapshots are emitted incrementally as
> `data-fict-snapshot` scripts (shell + each resolved boundary). When
> `snapshotTarget: 'head'`, each chunk injects into `<head>` via a small script.

```typescript
import { renderToStream } from '@fictjs/ssr'

const stream = renderToStream(() => <App />, { mode: 'shell' })
```

#### Strict CSP Streaming Runtime

For routes that disallow inline patch scripts, serve the packaged classic script
asset and enable observer patch mode:

```typescript
import { renderToStream } from '@fictjs/ssr'

const stream = renderToStream(() => <App />, {
  mode: 'shell',
  streamRuntime: 'external',
  streamRuntimeSrc: '/assets/fict-stream-runtime.js',
})
```

The asset is published as `@fictjs/ssr/fict-stream-runtime.js`. Build tools that
need to materialize it themselves can import `createStreamRuntimeCode` from
`@fictjs/ssr/stream-runtime`.

Trusted Types deployments should use this external observer runtime. The patch
runtime moves `<template>` content with DOM APIs (`content` + `insertBefore`) and
does not call `innerHTML`, `insertAdjacentHTML`, `eval`, or `Function`.

When Preview snapshots are enabled on a nonce-free strict-CSP route, keep
`snapshotTarget` at `container` or `body`. Incremental `head` snapshots require a
small executable mover; external runtime mode rejects that combination unless
`scriptNonce` is non-empty.

Each shell stream receives an automatic unique namespace for its Suspense patch
identifiers. When independently cached fragments or streams from multiple
services can be composed into one document, pass a stable
`streamIdentifierPrefix` that is unique within that final document:

```typescript
renderToStream(() => <App />, {
  mode: 'shell',
  streamIdentifierPrefix: 'account_shell',
})
```

The prefix only affects streaming patch identifiers; resumable scope IDs are
unchanged. Reusing a prefix for two live streams in the same document can make
their patches ambiguous. Prefixes accept 1-128 ASCII letters, digits, `_`, `.`,
`:`, or `-`, but may not contain `--`.

### renderToPipeableStream

Node.js-style stream variant (compatible with `pipe()`).

```typescript
import { renderToPipeableStream } from '@fictjs/ssr'

const { pipe, shellReady, allReady } = renderToPipeableStream(() => <App />, { mode: 'shell' })
pipe(res)
await shellReady
await allReady
```

> Use `renderToStream()` in Edge runtimes (Cloudflare Workers, Vercel Edge, Deno Deploy).

### renderToPartial

Generate a complete shell HTML plus a deferred patch stream for Partial Prerendering workflows.
This is an advanced API and currently considered **Experimental Preview** in v1.0; do not treat the return shape as frozen.
Import it from the explicit Preview entrypoint, not the supported package main export.

```typescript
import { renderToPartial } from '@fictjs/ssr/experimental'

const { shell, stream, shellReady, allReady } = renderToPartial(() => <App />, {
  mode: 'shell',
  fullDocument: true,
})
```

- `shell`: complete HTML document (fallbacks + boundary markers + initial snapshots)
- `stream`: patch chunks (`data-fict-suspense` + incremental snapshots) for deferred delivery
- `shellReady` / `allReady`: readiness signals for orchestration

### createSSRDocument

```typescript
function createSSRDocument(html?: string): SSRDom

interface SSRDom {
  window: Window
  document: Document
}
```

Creates a virtual DOM environment for SSR.

### installResumableLoader

```typescript
function installResumableLoader(options?: ResumableLoaderOptions): void

interface ResumableLoaderOptions {
  document?: Document
  snapshotScriptId?: string
  events?: string[] // Default: DelegatedEvents
  snapshotMigrations?: Record<number, SnapshotMigration>
  onSnapshotIssue?: (issue: SnapshotIssue) => void
  onSnapshotRejected?: (issue: SnapshotIssue) => void | Promise<void>
  prefetch?: PrefetchStrategy | false
}

type SnapshotMigration = (
  snapshot: Record<string, unknown>,
  context: SnapshotMigrationContext,
) => unknown

interface SnapshotMigrationContext {
  fromVersion: number
  toVersion: number
  source: string
}

interface SnapshotIssue {
  code:
    | 'snapshot_parse_error'
    | 'snapshot_invalid_shape'
    | 'snapshot_unsupported_version'
    | 'snapshot_migration_failed'
    | 'snapshot_fallback_failed'
    | 'scope_snapshot_missing'
    | 'resume_import_failed'
    | 'resume_function_missing'
    | 'resume_failed'
    | 'handler_import_failed'
    | 'handler_missing'
    | 'handler_failed'
  message: string
  source: string
  expectedVersion: number
  actualVersion?: number
  scopeId?: string
  qrl?: string
  url?: string
  exportName?: string
  eventType?: string
  error?: unknown
}

interface PrefetchStrategy {
  visibility?: boolean // Default: true
  visibilityMargin?: string // Default: '200px'
  hover?: boolean // Default: true
  hoverDelay?: number // Default: 50
}

type LegacySnapshotFormat = 'raw-props' | 'encoded-props'
const UNVERSIONED_SNAPSHOT_MIGRATION_KEY = 0
function createLegacySnapshotMigration(format: LegacySnapshotFormat): SnapshotMigration
```

The current writer emits v2. Missing `v` and v1 fail closed unless the
application explicitly selects the matching historical writer dialect. The
loader cannot infer whether v1 `{ "__t": "u" }` bytes mean literal data or an
encoded `undefined` value. See the
[SSR / Resume Stability Contract](../../docs/ssr-resume-stability-contract.md)
for the version map and migration examples.

`onSnapshotIssue` is telemetry-only. `onSnapshotRejected` runs once after the
loader disengages; the application must mount the CSR root. Fict does not mount
CSR automatically, and it does not route QRL failures to an ErrorBoundary.

## Architecture Design

### Build Time

```
┌──────────────────────────────────────────────────────────────┐
│                        Fict Compiler                         │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Source Code                 Build Output                    │
│  ───────────                 ────────────                    │
│  onClick$={() => count++}    1. Main bundle (incl resume fn) │
│                              2. Handler chunk (lazy loaded)  │
│                              3. QRL Ref (HTML attribute)     │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

**Generated Code Structure:**

The exact generated ABI is compiler-owned and may change while resumability is
Preview. Conceptually, the main bundle registers a resume function that restores
the scope and reconnects reactive bindings. Each extracted handler chunk exports
the function named by its QRL; the loader restores the lexical scope before it
invokes that handler. Use compiler fixture output and package tests—not copied
generated snippets—as the compatibility source of truth.

### Runtime

```
┌─────────────────────────────────────────────────────────────────┐
│                     Resumable Loader                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. Parse snapshot ──────────► Store in snapshotState           │
│                                                                 │
│  2. Register event delegation ──────► doc.addEventListener      │
│                                                                 │
│  3. On Event Trigger:                                           │
│     ┌─────────────────────────────────────────────────────┐     │
│     │ a. Look up on:* attribute to get QRL                │     │
│     │ b. Check if hydrated                                │     │
│     │ c. If not hydrated:                                 │     │
│     │    - Load resume module                             │     │
│     │    - Get resume fn from registry                    │     │
│     │    - Execute resume (restore state + bind)          │     │
│     │ d. Load handler chunk                               │     │
│     │ e. Execute handler                                  │     │
│     └─────────────────────────────────────────────────────┘     │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Manifest File

Generated detailed `fict.manifest.json` during production build, mapping virtual modules to actual chunks:

```json
{
  "fict:module:m0123456789abcdef0123456789abcdef": "/assets/index-xyz789.js",
  "virtual:fict-handler:h0123456789abcdef0123456789abcdef$$__fict_e0": "/assets/handler-e0-abc123.js",
  "virtual:fict-handler:h0123456789abcdef0123456789abcdef$$__fict_e1": "/assets/handler-e1-def456.js"
}
```

Only modules that own a resumable QRL are listed. Physical filenames and
unrelated Rollup modules are deliberately excluded.

Treat the manifest, SSR server, HTML snapshots, client loader, QRL chunks, and
external stream runtime as one build. Prefer a build-scoped manifest URL. If a
fixed `/fict.manifest.json` is unavoidable, serve it with `no-store` or mandatory
revalidation; do not let it use stale-while-revalidate independently from HTML.

## Integration with Vite

## Partial Prerendering

`renderToPartial()` is an **Experimental Preview** API that enables a PPR-style split:

1. **Shell phase**: serve/cache `shell` as static-first HTML.
2. **Deferred phase**: deliver `stream` patches for resolved Suspense boundaries.

This keeps shell TTFB low while still allowing server-resolved dynamic islands.
The shell and every deferred patch must come from the same build and snapshot
schema; never combine a cached shell with a newer server's patch stream.

## Edge Runtime

`@fictjs/ssr` can run in Edge environments via `renderToStream()` and `renderToString()`.

Notes:

- `manifest` as an object works in all runtimes.
- `manifest` as a file path string requires Node.js or Deno sync file access.
- Prefer `renderToStream()` over `renderToPipeableStream()` for Edge.

### vite.config.ts

```typescript
import { defineConfig } from 'vite'
import fict from '@fictjs/vite-plugin'

export default defineConfig({
  plugins: [
    fict({
      resumable: true,
      autoExtractHandlers: true,
      autoExtractThreshold: 3,
    }),
  ],
})
```

### Configuration Options

```typescript
interface FictPluginOptions {
  // Resumability
  resumable?: boolean // Enable resumable mode
  autoExtractHandlers?: boolean // Auto extract handlers
  autoExtractThreshold?: number // Auto extract threshold (default: 3)

  // Build Options
  fineGrainedDom?: boolean // Fine-grained DOM updates
  optimize?: boolean // HIR Optimization
  // ...
}
```

### Build Output

```
dist/
├── client/
│   ├── index.html
│   ├── fict.manifest.json
│   └── assets/
│       ├── index-abc123.js          # Main bundle
│       ├── chunk-xyz789.js          # Shared chunk (runtime)
│       ├── handler-__fict_e0-*.js   # Handler chunk
│       ├── handler-__fict_e1-*.js
│       └── handler-__fict_e2-*.js
└── server/
    └── entry-server.js              # SSR bundle
```

## Advanced Usage

### Custom SSR Server

```typescript
// server.js
import express from 'express'
import { renderToString } from '@fictjs/ssr'
import { App } from './dist/server/entry-server.js'

const app = express()

// Static assets
app.use('/assets', express.static('dist/client/assets'))

// SSR Route
app.get('*', async (req, res) => {
  const manifest = JSON.parse(
    fs.readFileSync('dist/client/fict.manifest.json', 'utf-8')
  )

  const appHtml = renderToString(() => <App url={req.url} />, {
    manifest,
    containerId: 'app',
  })

  const html = template.replace('<!--app-html-->', appHtml)
  res.send(html)
})
```

### Streaming Rendering

```typescript
import { renderToPipeableStream } from '@fictjs/ssr'

app.get('*', async (req, res) => {
  const { pipe, shellReady, allReady } = renderToPipeableStream(() => <App />, {
    mode: 'shell',
  })

  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  pipe(res)

  await shellReady
  await allReady
})
```

### Prefetch Strategy

```typescript
installResumableLoader({
  prefetch: {
    // Prefetch when element enters viewport
    visibility: true,
    visibilityMargin: '500px', // Start prefetch 500px early

    // Prefetch on hover
    hover: true,
    hoverDelay: 100, // 100ms debounce
  },
})
```

### Disable Extraction for Specific Handlers

```tsx
// Use normal onClick and set autoExtractHandlers: false
// Or ensure handler is simple enough not to trigger auto-extraction

<button onClick={() => count++}>  // Simple, not extracted
```

## Performance Optimization

### 1. Handler Chunk Size Optimization

```typescript
// ❌ Not Recommended: Large dependency in handler
<button onClick$={async () => {
  const { parse } = await import('large-library')
  parse(data)
}}>

// ✅ Recommended: Import at component level
import { parse } from 'large-library'
<button onClick$={() => parse(data)}>
```

### 2. Prefetch Tuning

```typescript
// For critical interactions, use more aggressive preloading
installResumableLoader({
  prefetch: {
    visibility: true,
    visibilityMargin: '1000px', // Prefetch even earlier
  },
})
```

### 3. Reduce Serialization Overhead

```tsx
// ❌ Avoid serializing large objects
let largeData = $state(hugeArray)

// ✅ Recommended: Serialize only necessary data
let dataId = $state(id) // Store ID only, fetch on client
```

## Production Guides

- [SSR SEO Guide](../../docs/ssr-seo.md)
- [SSR Performance Tuning](../../docs/ssr-performance.md)
- [SSR Deployment Guide](../../docs/ssr-deployment.md)
- [SSR / Resume Stability Contract](../../docs/ssr-resume-stability-contract.md)

## Troubleshooting

### Common Issues

#### 1. "Failed to fetch dynamically imported module"

**Cause:** Manifest not loaded correctly or QRL path mismatch.

**Solution:**

```typescript
// Ensure manifest is loaded before installResumableLoader
await loadManifest()
installResumableLoader(...)
```

#### 2. Handler called but DOM not updating

**Cause:** Resume function not executed or not correctly registered.

**Check:**

```typescript
// Ensure resume function is registered
import { __fictGetResume } from '@fictjs/runtime/internal'
console.log(__fictGetResume('__fict_r0')) // Should return function
```

#### 3. "ReferenceError: xxx is not defined"

**Cause:** Handler chunk references uncaptured variable.

**Solution:** Ensure all required variables are in closure scope.

#### 4. Snapshot too large

**Cause:** Serializing large amount of data.

**Solution:**

```tsx
// Serialize only lightweight state, then load details from a resumable client interaction.
let data = $state(null)

return (
  <button
    onClick$={async () => {
      data = await fetchData(itemId)
    }}
  >
    Load details
  </button>
)
```

`onMount` is synchronous and also runs during server rendering. Do not use an async `onMount`
callback for client bootstrapping: returned promises are not awaited, and a cleanup resolved from a
promise is not registered. If data must load automatically on the client, use an explicit
client-only/CSR bootstrap instead.

### Debugging Tips

```typescript
// Enable loader logs (during dev)
// Console.log statements in loader.ts can help debug

// Check manifest content
console.log(globalThis.__FICT_MANIFEST__)

// Check snapshot content
const fullSnapshot = document.getElementById('__FICT_SNAPSHOT__')
if (fullSnapshot?.textContent) {
  console.log(JSON.parse(fullSnapshot.textContent))
}
// In streaming shell mode, snapshots are chunked:
const snapshots = document.querySelectorAll('script[data-fict-snapshot]')
for (const script of snapshots) {
  console.log(JSON.parse(script.textContent || '{}'))
}
```

## Related Packages

- `@fictjs/runtime` - Core runtime, containing signal/effect system
- `@fictjs/compiler` - Babel plugin, handling JSX transform and handler extraction
- `@fictjs/vite-plugin` - Vite integration, handling build and code splitting

## License

MIT
