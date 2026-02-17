# Fict DevTools and Playground Engineering

**Version 1.0.0**  
Fict Core Team  
February 2026

> **Note:**  
> This document is primarily written for coding agents maintaining Fict repositories.  
> It emphasizes deterministic workflows, fail-closed correctness, and repeatable release quality.

---

## Abstract

Best-practice guide for implementing and debugging Fict DevTools and Playground. Focuses on transport handshake correctness, inspector UX consistency, graph/timeline completeness, preview refresh fidelity, and release-grade validation without affecting production runtime performance.

---

## Table of Contents

1. [Bridge and Transport Correctness](#1-bridge-and-transport-correctness) — **CRITICAL**
   - 1.1 [Align Standalone and Extension Handshake Contracts](#11-align-standalone-and-extension-handshake-contracts)
   - 1.2 [Gate Devtools Bridge to Development Paths](#12-gate-devtools-bridge-to-development-paths)
2. [Inspector Data Semantics](#2-inspector-data-semantics) — **HIGH**
   - 2.1 [Make Owner Navigation Expand and Focus the Component Tree](#21-make-owner-navigation-expand-and-focus-the-component-tree)
   - 2.2 [Prefer Semantic Names for Computed and Effects](#22-prefer-semantic-names-for-computed-and-effects)
3. [Graph and Timeline UX](#3-graph-and-timeline-ux) — **HIGH**
   - 3.1 [Enable Click-to-Jump from Timeline Nodes](#31-enable-click-to-jump-from-timeline-nodes)
   - 3.2 [Keep Graph Owner Links Clickable and Navigable](#32-keep-graph-owner-links-clickable-and-navigable)
   - 3.3 [Render Dependency Graphs for Signal, Computed, and Effect Nodes](#33-render-dependency-graphs-for-signal-computed-and-effect-nodes)
4. [Playground Preview Runtime](#4-playground-preview-runtime) — **HIGH**
   - 4.1 [Keep Playground Runtime and Production Runtime Isolated](#41-keep-playground-runtime-and-production-runtime-isolated)
   - 4.2 [Preserve Preview Refresh Fidelity on Source Changes](#42-preserve-preview-refresh-fidelity-on-source-changes)
5. [Verification and Shipping Gates](#5-verification-and-shipping-gates) — **CRITICAL**
   - 5.1 [Keep Standalone and Extension Behavior in Parity](#51-keep-standalone-and-extension-behavior-in-parity)
   - 5.2 [Validate Changes in examples/counter-basic End-to-End](#52-validate-changes-in-examplescounter-basic-end-to-end)

---

## 1. Bridge and Transport Correctness

**Impact: CRITICAL**

Transport handshake and message contracts must be deterministic across standalone and extension environments.

### 1.1 Align Standalone and Extension Handshake Contracts

**Impact: CRITICAL (prevents dead panels and missing runtime data)**

The devtools panel should use the same message contract in standalone and
extension modes. A contract mismatch causes silent "connected but no data"
states.

**Incorrect: mode-specific payload mismatch**

```ts
// standalone panel
postMessage({ type: 'connect', payload: { tab: tabId } })

// extension bridge expects
// { type: 'connect', payload: { targetId } }
```

**Correct: single shared message schema**

```ts
export interface DevtoolsConnectPayload {
  targetId?: number
  standalone: boolean
}

postMessage({
  type: 'connect',
  payload: {
    targetId: tabId,
    standalone: true,
  } satisfies DevtoolsConnectPayload,
})
```

Reference: [https://github.com/fictjs/fict/blob/main/packages/devtools/README.md](https://github.com/fictjs/fict/blob/main/packages/devtools/README.md)

### 1.2 Gate Devtools Bridge to Development Paths

**Impact: CRITICAL (avoids production runtime overhead and attack surface)**

Only inject devtools bridge code in development serve workflows. Avoid loading
bridge runtime in production bundles.

**Incorrect: bridge always enabled**

```ts
import 'virtual:fict-devtools'
```

**Correct: conditional dev-only injection**

```ts
if (import.meta.env.DEV) {
  await import('virtual:fict-devtools')
}
```

Reference: [https://github.com/fictjs/fict/blob/main/packages/devtools/README.md](https://github.com/fictjs/fict/blob/main/packages/devtools/README.md)

---

## 2. Inspector Data Semantics

**Impact: HIGH**

Inspector data should map to meaningful runtime entities with stable labels and reliable ownership navigation.

### 2.1 Make Owner Navigation Expand and Focus the Component Tree

**Impact: HIGH (avoids dead-end navigation in deep component hierarchies)**

Clicking owner/component references from signals/effects/computed views should
navigate to the component page, expand all ancestor nodes, and focus the target.

**Incorrect: navigates but does not expand ancestors**

```ts
router.push(`/components/${ownerId}`)
```

**Correct: expand path and focus target**

```ts
router.push(`/components/${ownerId}`)
expandAncestorChain(ownerId)
focusComponentNode(ownerId)
```

Reference: [https://github.com/fictjs/fict/blob/main/examples/counter-basic/](https://github.com/fictjs/fict/blob/main/examples/counter-basic/)

### 2.2 Prefer Semantic Names for Computed and Effects

**Impact: HIGH (improves debugging speed and signal traceability)**

When compiler/runtime metadata can infer source variable or owner names, expose
those names in devtools instead of only generated ids like `Computed #2`.

**Incorrect: id-only labels**

```text
Computed #2
Effect #5
```

**Correct: semantic + id labels**

```text
doubled:Computed #2
Counter:Effect #5
```

Reference: [https://github.com/fictjs/fict/blob/main/docs/reactivity-semantics.md](https://github.com/fictjs/fict/blob/main/docs/reactivity-semantics.md)

---

## 3. Graph and Timeline UX

**Impact: HIGH**

Graph and timeline views should expose complete dependency relationships and provide actionable navigation flows.

### 3.1 Enable Click-to-Jump from Timeline Nodes

**Impact: HIGH (enables time-to-cause correlation during reactive debugging)**

Timeline entries should support direct navigation to related signal/computed/
effect/component entities.

**Incorrect: timeline entries are non-interactive**

```tsx
<li>{event.label}</li>
```

**Correct: timeline entries jump to target context**

```tsx
<li>
  <button onClick={() => jumpToTimelineTarget(event.target)}>{event.label}</button>
</li>
```

Reference: [https://github.com/fictjs/fict/blob/main/examples/counter-basic/](https://github.com/fictjs/fict/blob/main/examples/counter-basic/)

### 3.2 Keep Graph Owner Links Clickable and Navigable

**Impact: HIGH (improves root-cause tracing from graph context)**

Owner references in graph details should be interactive and route to the owning
component context.

**Incorrect: owner rendered as plain text**

```tsx
<div>Owner: {ownerName}</div>
```

**Correct: owner rendered as action link**

```tsx
<button onClick={() => jumpToOwner(ownerId)}>Owner: {ownerName}</button>
```

Reference: [https://github.com/fictjs/fict/blob/main/examples/counter-basic/](https://github.com/fictjs/fict/blob/main/examples/counter-basic/)

### 3.3 Render Dependency Graphs for Signal, Computed, and Effect Nodes

**Impact: HIGH (prevents partial observability and false-negative diagnosis)**

Graph rendering must work for all inspectable node types, not just signals.
Missing computed/effect graph support hides critical dependency chains.

**Incorrect: graph only handles signal nodes**

```ts
if (node.kind === 'signal') {
  renderSignalGraph(node)
}
```

**Correct: type-normalized graph query**

```ts
switch (node.kind) {
  case 'signal':
  case 'computed':
  case 'effect':
    renderDependencyGraph(node.id)
    break
}
```

Reference: [https://github.com/fictjs/fict/blob/main/docs/architecture.md](https://github.com/fictjs/fict/blob/main/docs/architecture.md)

---

## 4. Playground Preview Runtime

**Impact: HIGH**

Preview updates must be faithful to source edits while keeping playground execution isolated from production runtime paths.

### 4.1 Keep Playground Runtime and Production Runtime Isolated

**Impact: HIGH (protects production runtime from playground-specific complexity)**

Playground helpers should stay behind explicit adapters. Do not mix playground
session logic into core runtime package entry points.

**Incorrect: runtime imports playground helpers**

```ts
// packages/runtime/src/index.ts
import { setupPreviewMessaging } from '@fictjs/playground'
setupPreviewMessaging()
```

**Correct: playground imports runtime, not reverse**

```ts
// packages/playground/src/preview-runtime.ts
import { render } from 'fict'

export function bootPreview(view: () => unknown, mount: HTMLElement) {
  render(view as never, mount)
}
```

Reference: [https://github.com/fictjs/fict/blob/main/docs/architecture.md](https://github.com/fictjs/fict/blob/main/docs/architecture.md)

### 4.2 Preserve Preview Refresh Fidelity on Source Changes

**Impact: HIGH (avoids stale preview and misleading DX)**

When source files change, preview should either apply HMR updates or execute a
reliable full reload fallback. Never keep stale rendered output silently.

**Incorrect: file changes do not propagate**

```ts
watchSourceFiles(() => {
  // update state only
  setEditorDirty(true)
})
```

**Correct: HMR first, full reload fallback**

```ts
watchSourceFiles(async changed => {
  const handled = await tryHotUpdate(changed)
  if (!handled) {
    reloadPreviewFrame({ reason: 'hmr-fallback' })
  }
})
```

Reference: [https://github.com/fictjs/fict/blob/main/packages/playground/README.md](https://github.com/fictjs/fict/blob/main/packages/playground/README.md)

---

## 5. Verification and Shipping Gates

**Impact: CRITICAL**

Devtools/playground changes require behavior verification in real examples and parity checks across deployment modes.

### 5.1 Keep Standalone and Extension Behavior in Parity

**Impact: CRITICAL (prevents environment-specific regressions after release)**

Any feature added to standalone mode should be checked in extension mode (and
vice versa) against the same acceptance criteria.

**Incorrect: validate only standalone**

```text
Tested at /__fict-devtools__/ only.
Extension scenario not checked.
```

**Correct: dual-mode parity checks**

```text
Validate both modes:
1. standalone /__fict-devtools__/
2. extension panel

Ensure parity for:
- handshake/connect
- inspector data
- graph/timeline navigation
- error handling behavior
```

Reference: [https://github.com/fictjs/fict/blob/main/packages/devtools/README.md](https://github.com/fictjs/fict/blob/main/packages/devtools/README.md)

### 5.2 Validate Changes in examples/counter-basic End-to-End

**Impact: CRITICAL (catches integration bugs missed by isolated tests)**

For devtools/playground changes, run the real example app and verify data flow,
navigation, graph rendering, and timeline interactions in browser.

**Incorrect: unit tests only**

```bash
pnpm --filter @fictjs/devtools test
```

**Correct: example-driven validation**

```bash
pnpm --dir examples/counter-basic dev
# Open app page and devtools page, verify:
# - signals/computed/effects lists
# - graph rendering for all node types
# - click-to-jump navigation
```

Reference: [https://github.com/fictjs/fict/blob/main/examples/counter-basic/](https://github.com/fictjs/fict/blob/main/examples/counter-basic/)

---

## References

1. [https://github.com/fictjs/fict/blob/main/packages/devtools/README.md](https://github.com/fictjs/fict/blob/main/packages/devtools/README.md)
2. [https://github.com/fictjs/fict/blob/main/packages/playground/README.md](https://github.com/fictjs/fict/blob/main/packages/playground/README.md)
3. [https://github.com/fictjs/fict/blob/main/examples/counter-basic/](https://github.com/fictjs/fict/blob/main/examples/counter-basic/)
4. [https://github.com/fictjs/fict/blob/main/docs/architecture.md](https://github.com/fictjs/fict/blob/main/docs/architecture.md)
5. [https://github.com/fictjs/fict/blob/main/docs/reactivity-semantics.md](https://github.com/fictjs/fict/blob/main/docs/reactivity-semantics.md)
