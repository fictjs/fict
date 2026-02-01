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

```typescript
function serializeSlots(ctx: HookContext): SlotSnapshot[] {
  const slots: SlotSnapshot[] = []

  for (let i = 0; i < ctx.slots.length; i++) {
    const value = ctx.slots[i]

    if (isSignal(value)) {
      // Signal: Serialize current value
      slots.push([i, 'sig', serializeValue(value())])
    } else if (isStoreProxy(value)) {
      // Store: Serialize entire object
      slots.push([i, 'store', serializeValue(unwrapStore(value))])
    } else {
      // Raw value
      slots.push([i, 'raw', serializeValue(value)])
    }
  }

  return slots
}

function serializeValue(value: unknown): unknown {
  // Handle special types
  if (value === undefined) return { __t: 'u' }
  if (Number.isNaN(value)) return { __t: 'n' }
  if (value === Infinity) return { __t: '+i' }
  if (value === -Infinity) return { __t: '-i' }
  if (value instanceof Date) return { __t: 'd', v: value.getTime() }
  if (value instanceof Map) return { __t: 'm', v: [...value.entries()] }
  if (value instanceof Set) return { __t: 's', v: [...value] }
  if (value instanceof RegExp) return { __t: 'r', v: { s: value.source, f: value.flags } }
  if (typeof value === 'bigint') return { __t: 'b', v: value.toString() }

  // Recursively handle objects and arrays
  if (Array.isArray(value)) return value.map(serializeValue)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, serializeValue(v)]))
  }

  return value
}
```

## 4. Client Layer Details

### 4.1 Loader Initialization

```typescript
function installResumableLoader(options) {
  // 1. Parse snapshot
  const snapshotEl = document.getElementById('__FICT_SNAPSHOT__')
  if (snapshotEl?.textContent) {
    const state = JSON.parse(snapshotEl.textContent)
    __fictSetSSRState(state)
  }

  // 2. Enable resumable mode
  __fictEnableResumable()

  // 3. Register event delegation
  const events = options.events ?? DelegatedEvents
  for (const eventName of events) {
    document.addEventListener(eventName, handleResumableEvent, true)
  }

  // 4. Set up prefetch
  if (options.prefetch !== false) {
    setupPrefetch(document, options.prefetch)
  }
}
```

### 4.2 Event Handling Process

```typescript
async function handleResumableEvent(event) {
  // 1. Traverse event path
  const path = event.composedPath()
  for (const node of path) {
    const qrl = node.getAttribute(`on:${event.type}`)
    if (!qrl) continue

    // 2. Get scope info
    const host = node.closest('[data-fict-s]')
    const scopeId = host.getAttribute('data-fict-s')

    // 3. Restore snapshot data
    const snapshot = __fictGetSSRScope(scopeId)
    if (snapshot) {
      __fictEnsureScope(scopeId, host, snapshot)
    }

    // 4. First interaction requires hydrate
    if (!hydratedScopes.has(scopeId)) {
      const resumeQrl = host.getAttribute('data-fict-h')
      const { url, exportName } = parseQrl(resumeQrl)

      // Load and execute resume function
      await import(resolveModuleUrl(url))
      const resumeFn = __fictGetResume(exportName)
      await resumeFn(scopeId, host)

      hydratedScopes.add(scopeId)
    }

    // 5. Load and execute handler
    const { url, exportName } = parseQrl(qrl)
    const mod = await import(resolveModuleUrl(url))
    await mod[exportName](scopeId, event, node)

    return
  }
}
```

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

```typescript
function __fictUseLexicalScope(scopeId, varNames) {
  const scope = resumedScopes.get(scopeId)
  if (!scope) {
    throw new Error(`Scope ${scopeId} not found`)
  }

  return varNames.map(name => {
    const slotIndex = scope.ctx.slotMap[name]
    return scope.ctx.slots[slotIndex]
  })
}

function __fictRestoreSignal(snapshot, index) {
  const [, type, value] = snapshot.slots.find(([i]) => i === index)

  if (type === 'sig') {
    return createSignal(deserializeValue(value))
  }
  if (type === 'store') {
    return createStore(deserializeValue(value))
  }
  return deserializeValue(value)
}

function deserializeValue(value) {
  if (!value || typeof value !== 'object') return value

  if ('__t' in value) {
    switch (value.__t) {
      case 'u':
        return undefined
      case 'n':
        return NaN
      case '+i':
        return Infinity
      case '-i':
        return -Infinity
      case 'd':
        return new Date(value.v)
      case 'm':
        return new Map(value.v.map(([k, v]) => [deserializeValue(k), deserializeValue(v)]))
      case 's':
        return new Set(value.v.map(deserializeValue))
      case 'r':
        return new RegExp(value.v.s, value.v.f)
      case 'b':
        return BigInt(value.v)
    }
  }

  if (Array.isArray(value)) return value.map(deserializeValue)

  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deserializeValue(v)]))
}
```

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
