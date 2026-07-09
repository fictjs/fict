# Fict SSR Architecture Details

This document provides an in-depth look at the internal architecture and implementation details of Fict SSR.

## 1. Overall Architecture

### 1.1 Three-Layer Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                      Build Layer (Build Time)                      │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │  Fict Compiler   │  │   Vite Plugin    │  │   Rollup Plugin  │  │
│  │  - JSX Transform │  │  - Handler Extr. │  │  - Chunk Split   │  │
│  │  - HIR Gen       │  │  - Virtual Mods  │  │  - Manifest      │  │
│  │  - QRL Gen       │  │  - Code Split    │  │                  │  │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌────────────────────────────────────────────────────────────────────┐
│                      Server Layer (Server Time)                    │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │   @fictjs/ssr    │  │   SSR Runtime    │  │  State Serialize │  │
│  │  - renderToString│  │  - DOM Simul.    │  │  - Signal        │  │
│  │  - DOM Creation  │  │  - Comp Exec     │  │  - Store         │  │
│  │  - Snapshot Inj. │  │  - Scope Reg     │  │  - Complex Types │  │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌────────────────────────────────────────────────────────────────────┐
│                      Client Layer (Client Time)                    │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │   Loader         │  │   Resume System  │  │  Reactivity Sys  │  │
│  │  - Event Deleg.  │  │  - State Restore │  │  - Signal Bind   │  │
│  │  - Module Load   │  │  - Scope Restore │  │  - Effect Exec   │  │
│  │  - Prefetch      │  │  - DOM Bind      │  │  - DOM Update    │  │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

### 1.2 Data Flow

```
Source Code (.tsx)
     │
     ▼ [Compiler]
Generate HIR + Handler Functions
     │
     ▼ [Vite Plugin]
Extract Handlers → Virtual Modules
     │
     ▼ [Rollup]
Bundle → Main Bundle + Handler Chunks + Manifest
     │
     ▼ [SSR Runtime]
Execute Component → Generate HTML + Serialize Snapshot
     │
     ▼ [Client]
Parse Snapshot → Event Trigger → Lazy Load → Resume → Execute Handler
```

## 2. Build Layer Details

### 2.1 Handler Extraction Process

```typescript
// Input
<button onClick$={() => count++}>Click</button>

// Compiler processing steps:

// Step 1: Identify resumable handler (onClick$)
const isResumableEvent = name.endsWith('$')

// Step 2: Generate handler ID
const handlerId = createHandlerId(filename, handlerIndex)
// → "/src/App.tsx$$__fict_e0"

// Step 3: Extract handler code
const handlerCode = `
  import { __fictUseLexicalScope } from '@fictjs/runtime/internal';
  export default (scopeId, event, el) => {
    const [count] = __fictUseLexicalScope(scopeId, ["count"]);
    count++;
  };
`

// Step 4: Register virtual module
handlerRegistry.set(handlerId, handlerCode)

// Step 5: Generate QRL
const qrl = `virtual:fict-handler:${handlerId}#default`

// Step 6: Output HTML
<button on:click="${qrl}">Click</button>
```

### 2.2 Resume Function Generation

```typescript
// Compiler generated resume function
const __fict_r0 = (scopeId, host) => {
  // 1. Get snapshot data
  const scope = __fictGetSSRScope(scopeId)

  // 2. Restore state
  let count = __fictRestoreSignal(scope, 0) // slot 0

  // 3. Establish reactive bindings
  const textNode = host.querySelector('.counter-value')
  $effect(() => {
    textNode.textContent = String(count)
  })

  // 4. Set scope
  __fictSetScope(scopeId, { count })
}

// Register to prevent tree-shaking
__fictRegisterResume('__fict_r0', __fict_r0)
```

### 2.3 Auto-Extraction Heuristic Algorithm

```typescript
function shouldAutoExtract(expr, ctx) {
  // Rule 1: External function reference → Extract
  if (expr.kind === 'Identifier') return true

  // Rule 2: Async operation → Extract
  if (hasAsyncAwait(expr)) return true

  // Rule 3: External calls → Extract
  if (hasExternalCalls(expr)) return true

  // Rule 4: Complexity threshold → Extract
  const nodeCount = countExpressionNodes(expr)
  if (nodeCount >= ctx.autoExtractThreshold) return true

  return false
}
```

## 3. Server Layer Details

### 3.1 DOM Simulation

Using `linkedom` to create a lightweight DOM environment:

```typescript
function createSSRDocument(html: string): SSRDom {
  const window = parseHTML(html)
  return { window, document: window.document }
}
```

**Exposed Global Objects:**

```typescript
const globals = {
  window,
  document,
  self,
  Node,
  Element,
  HTMLElement,
  SVGElement,
  Document,
  DocumentFragment,
  Text,
  Comment,
  Range,
  Event,
  CustomEvent,
  MutationObserver,
  DOMParser,
  getComputedStyle,
}
```

### 3.2 Scope Registration Mechanism

```typescript
// Register scope during component rendering
function __fictRegisterScope(ctx, host, type, props) {
  const id = `s${++scopeCounter}` // s1, s2, s3...

  // Set DOM attributes
  host.setAttribute('data-fict-s', id)
  host.setAttribute('data-fict-t', type)
  host.setAttribute('data-fict-h', resumeQrl)

  // Record to registry
  scopeRegistry.set(id, { id, ctx, host, type, props })

  return id
}
```

### 3.3 State Serialization

The runtime owns the codec in `packages/runtime/src/resume.ts`; architecture
docs do not duplicate its implementation. Stable invariants are:

- every current writer emits schema v2;
- scope slots and props use the same recursive value codec;
- literal objects containing `__t` are escaped so they cannot collide with a
  marker;
- shared/circular references, array holes, symbol keys, and supported built-ins
  preserve their semantics;
- unsupported objects and functions inside value-bearing containers fail
  serialization instead of silently changing value semantics;
- function-valued component-prop properties and function-valued raw slots are
  intentionally omitted by the existing compiler ABI.

Historical v1 writers used incompatible raw-props and encoded-props dialects.
Only an explicit migration selected by deployment history may accept them. See
the [SSR / Resume Stability Contract](../../../docs/ssr-resume-stability-contract.md).

### 3.4 Streaming SSR (Shell-first)

Fict can stream SSR output by emitting a shell (fallback UI + boundary markers) first,
then patching Suspense boundaries as they resolve.

Key pieces:

- **Boundary markers**: `<!--fict:suspense-start:ID--> ... <!--fict:suspense-end:ID-->`
- **Patch chunks**: `<template data-fict-suspense="ID">...</template><script>__FICT_STREAM.apply("ID")</script>`
- **Client patcher**: small runtime injected in the shell to apply patches.

Incremental snapshot scripts use the same v2 schema as the initial snapshot.
A cached shell and its deferred patches must remain on one build and schema.

## 4. Client Layer Details

### 4.1 Loader Initialization

`packages/runtime/src/loader.ts` follows this validation-first sequence:

```text
initial and incremental snapshot scripts
  -> parse JSON
  -> require v2 or run an explicitly registered migration
  -> validate state and scope shape
  -> replace/merge accepted scopes
  -> install snapshot observer, delegated events, and prefetch
```

Rejected payloads are never merged. When `onSnapshotRejected` is configured,
the loader removes its observer/listeners/prefetch state and clears the affected
resumable state before invoking the application callback once. The application
then mounts CSR. `onSnapshotIssue` alone is telemetry and never mounts a root.

### 4.2 Event Handling Process

For each delegated interaction the loader resolves the nearest `on:*` QRL,
requires an accepted scope snapshot, restores the scope, imports/runs its resume
function once, then imports/runs the handler. A missing scope emits
`scope_snapshot_missing`; without an application fallback callback that handler
is skipped and scanning may continue to a valid ancestor.

Resume and handler import/export/execution failures emit structured issue codes
and become no-ops. The loader does not promise ErrorBoundary routing or
automatic CSR for QRL failures.

### 4.3 Prefetch Strategy

```typescript
// Visibility-based prefetch
function setupVisibilityPrefetch(doc, rootMargin) {
  const observer = new IntersectionObserver(
    entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          prefetchElementQrls(entry.target)
          observer.unobserve(entry.target)
        }
      }
    },
    { rootMargin },
  )

  // Observe all interactive elements
  doc.querySelectorAll('[on\\:click], [data-fict-h]').forEach(el => observer.observe(el))
}

// Hover-based prefetch
function setupHoverPrefetch(doc, delay) {
  let timeout = null

  doc.addEventListener('pointerover', e => {
    const el = e.target.closest('[on\\:click], [data-fict-h]')
    if (!el) return

    timeout = setTimeout(() => {
      prefetchElementQrls(el)
    }, delay)
  })

  doc.addEventListener('pointerout', () => {
    if (timeout) clearTimeout(timeout)
  })
}

// Actual prefetch
function prefetchQrl(qrl) {
  const { url } = parseQrl(qrl)
  if (prefetchedUrls.has(url)) return

  prefetchedUrls.add(url)

  const link = document.createElement('link')
  link.rel = 'modulepreload'
  link.href = resolveModuleUrl(url)
  document.head.appendChild(link)
}
```

### 4.4 State Restoration

State restoration is owned by `packages/runtime/src/resume.ts`. Accepted v2
scope snapshots are validated before they enter runtime state, then restored as
one context so slots, props, variable indexes, shared references, and circular
references use the same reference table.

The stable flow is:

```text
validated v2 ScopeSnapshot
  -> deserialize slots and props with one reference map
  -> create or restore signal/store/raw slots
  -> register the resumed scope and its host
  -> expose lexical variables by the serialized slot index map
```

The codec includes marker collision escaping, negative zero, invalid dates,
RegExp `lastIndex`, global/well-known symbols, symbol-keyed and null-prototype
objects, array holes, and shared/circular references. Keeping a second
deserialize implementation in this document would be unsafe; the source type
`SerializedMarker`, runtime codec tests, and the
[SSR / Resume Stability Contract](../../../docs/ssr-resume-stability-contract.md)
are the verification sources.

## 5. Manifest System

### 5.1 Generation

```typescript
// Vite plugin generateBundle hook
generateBundle(options, bundle) {
  const manifest = {}

  for (const output of Object.values(bundle)) {
    if (output.type !== 'chunk') continue

    const url = joinBasePath(config.base, output.fileName)

    for (const moduleId of Object.keys(output.modules)) {
      // Virtual handler module
      if (moduleId.startsWith('\0fict-handler:')) {
        const handlerId = moduleId.slice('\0fict-handler:'.length)
        const virtualKey = `virtual:fict-handler:${handlerId}`
        manifest[virtualKey] = url
        continue
      }

      // Normal module
      const fileUrl = pathToFileURL(moduleId).href
      manifest[fileUrl] = url
    }
  }

  this.emitFile({
    type: 'asset',
    fileName: 'fict.manifest.json',
    source: JSON.stringify(manifest),
  })
}
```

### 5.2 Resolution

```typescript
function resolveModuleUrl(url: string): string {
  const manifest = globalThis.__FICT_MANIFEST__

  if (manifest) {
    const resolved = manifest[url]
    if (resolved) return resolved
  }

  return url // Return directly in dev mode
}
```

The SSR server, emitted HTML/snapshot, client loader, manifest, QRL chunks, and
external streaming runtime form one atomic build. A fixed-name manifest must be
revalidated and must not use stale-while-revalidate independently from HTML.
See the [SSR Deployment Guide](../../../docs/ssr-deployment.md).

## 6. Performance Features

### 6.1 Zero JS Initial Load

- HTML is completely statically rendered
- Content displays without JS execution
- Snapshot data embedded as JSON

### 6.2 On-Demand Loading

- Handlers load only on first interaction
- Smart preloading using `modulepreload`
- Predictive loading based on visibility and hover

### 6.3 Incremental Hydration

- Each component instance hydrates independently
- Only interacted components hydrate
- Uninteracted components remain static

### 6.4 Fine-Grained Updates

- Reactivity system established after hydration
- Updates only changed DOM nodes
- No Virtual DOM diff

## 7. Comparison with Other Frameworks

| Feature                 | Fict           | Qwik           | Next.js         | Nuxt            |
| ----------------------- | -------------- | -------------- | --------------- | --------------- |
| Rendering Mode          | Resumable      | Resumable      | Hydration       | Hydration       |
| Handler Granularity     | Function Level | Function Level | Component Level | Component Level |
| Auto Extraction         | ✅             | ❌             | ❌              | ❌              |
| First Interaction Delay | ~0ms           | ~0ms           | High            | High            |
| Prefetch                | Smart          | Manual         | Full Page       | Full Page       |
| Learning Curve          | Low            | Medium         | Low             | Low             |
