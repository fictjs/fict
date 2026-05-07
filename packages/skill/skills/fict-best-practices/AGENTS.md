# Fict Compiler and Runtime Best Practices

**Version 1.0.0**  
Fict Core Team  
February 2026

> **Note:**  
> This document is primarily written for coding agents maintaining Fict repositories.  
> It emphasizes deterministic workflows, fail-closed correctness, and repeatable release quality.

---

## Abstract

Comprehensive engineering guidance for Fict compiler/runtime work. Covers fail-closed reactivity guarantees, macro placement, state lifetime, effect safety, SSR resume stability, devtools/playground boundaries, and release verification workflows.

---

## Table of Contents

1. [Compiler Guarantees](#1-compiler-guarantees) — **CRITICAL**
   - 1.1 [Enforce Strict Guarantee Mode in CI](#11-enforce-strict-guarantee-mode-in-ci)
   - 1.2 [Keep Macros at Top-Level Component or Hook Scope](#12-keep-macros-at-top-level-component-or-hook-scope)
   - 1.3 [Treat Fallback Diagnostics as Blocking](#13-treat-fallback-diagnostics-as-blocking)
2. [Reactivity Semantics](#2-reactivity-semantics) — **CRITICAL**
   - 2.1 [Keep Props and Object Shaping Statically Analyzable](#21-keep-props-and-object-shaping-statically-analyzable)
   - 2.2 [Prevent State Escape Outside Owning Scope](#22-prevent-state-escape-outside-owning-scope)
   - 2.3 [Use Compiler-Derived Values Instead of Manual Snapshots](#23-use-compiler-derived-values-instead-of-manual-snapshots)
3. [Runtime Safety and Performance](#3-runtime-safety-and-performance) — **HIGH**
   - 3.1 [Always Return Cleanup for Effectful Resources](#31-always-return-cleanup-for-effectful-resources)
   - 3.2 [Keep Memo Computations Pure](#32-keep-memo-computations-pure)
   - 3.3 [Use the Right Primitive for Shared State Boundaries](#33-use-the-right-primitive-for-shared-state-boundaries)
4. [SSR and Resume Stability](#4-ssr-and-resume-stability) — **HIGH**
   - 4.1 [Key Async Resources and Place Suspense at Ownership Boundaries](#41-key-async-resources-and-place-suspense-at-ownership-boundaries)
   - 4.2 [Preserve Snapshot Schema and Loader Failure Semantics](#42-preserve-snapshot-schema-and-loader-failure-semantics)
5. [Tooling and DX Boundaries](#5-tooling-and-dx-boundaries) — **MEDIUM**
   - 5.1 [Isolate Playground Features from Runtime Core](#51-isolate-playground-features-from-runtime-core)
   - 5.2 [Keep DevTools Instrumentation Development-Only](#52-keep-devtools-instrumentation-development-only)
6. [Verification and Release Discipline](#6-verification-and-release-discipline) — **CRITICAL**
   - 6.1 [Add Focused Regression Tests for Every Bug Fix](#61-add-focused-regression-tests-for-every-bug-fix)
   - 6.2 [Run Compiler and Runtime Release Gates Before Merge](#62-run-compiler-and-runtime-release-gates-before-merge)

---

## 1. Compiler Guarantees

**Impact: CRITICAL**

Keep Fict compiler behavior fail-closed and deterministic. Any fallback diagnostic that weakens reactivity guarantees must be treated as a blocking issue in CI and code review.

### 1.1 Enforce Strict Guarantee Mode in CI

**Impact: CRITICAL (blocks fallback patterns from shipping)**

Always run production build pipelines with strict guarantee enforcement. In Fict,
`FICT_STRICT_GUARANTEE=1` forces compiler `strictGuarantee` globally and blocks
known fallback diagnostics that weaken the guarantee contract.

**Incorrect: CI allows guarantee downgrades**

```bash
pnpm build
```

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import fict from '@fictjs/vite-plugin'

export default defineConfig({
  plugins: [fict({ strictGuarantee: false })],
})
```

**Correct: CI fail-closed**

```bash
FICT_STRICT_GUARANTEE=1 pnpm build
```

```bash
FICT_STRICT_GUARANTEE=1 pnpm release:compiler:verify
```

Reference: [https://github.com/fictjs/fict/blob/main/docs/reactivity-guarantee-matrix.md](https://github.com/fictjs/fict/blob/main/docs/reactivity-guarantee-matrix.md)

### 1.2 Keep Macros at Top-Level Component or Hook Scope

**Impact: CRITICAL (prevents unsupported macro placement and undefined ordering)**

`$state`, `$effect`, and `$memo` must be declared at top-level scope of a
component or hook body. Do not place them inside loops, conditions, or nested
functions.

**Incorrect: unsupported placement**

```tsx
function Counter({ enabled }: { enabled: boolean }) {
  if (enabled) {
    let count = $state(0)
    $effect(() => console.log(count))
  }

  function setup() {
    let local = $state(1)
    return local
  }

  return null
}
```

**Correct: stable declaration order**

```tsx
function Counter({ enabled }: { enabled: boolean }) {
  let count = $state(0)

  $effect(() => {
    if (!enabled) return
    console.log(count)
  })

  return <button onClick={() => count++}>{count}</button>
}
```

Reference: [https://github.com/fictjs/fict/blob/main/docs/architecture.md](https://github.com/fictjs/fict/blob/main/docs/architecture.md)

### 1.3 Treat Fallback Diagnostics as Blocking

**Impact: CRITICAL (avoids silent downgrade from guaranteed semantics to fallback paths)**

Do not silence or normalize fallback diagnostics (`FICT-P*`, `FICT-R*`,
`FICT-J*`, `FICT-S002`) when working in strict guarantee paths. Rewrite code
into analyzable shapes instead of downgrading correctness policy.

**Incorrect: accepts fallback shapes**

```tsx
function Panel(props: Record<string, unknown>, key: string) {
  const { [key]: value } = props // dynamic destructuring can trigger fallback
  return <div>{String(value)}</div>
}
```

```ts
// build config (unsafe default for app code)
strictGuarantee: false
```

**Correct: rewrite to guaranteed form**

```tsx
function Panel(props: { title?: string }) {
  const title = props.title
  return <div>{title}</div>
}
```

```ts
// keep strict guarantee and fix diagnostics at source
strictGuarantee: true
```

Reference: [https://github.com/fictjs/fict/blob/main/docs/diagnostic-codes.md](https://github.com/fictjs/fict/blob/main/docs/diagnostic-codes.md)

---

## 2. Reactivity Semantics

**Impact: CRITICAL**

Preserve Fict's getter-based semantics so derived values, closures, and props remain live without stale snapshots.

### 2.1 Keep Props and Object Shaping Statically Analyzable

**Impact: CRITICAL (preserves reactive props instead of fallback snapshots)**

Prefer simple prop access/destructuring and explicit object shapes. Highly
dynamic computed keys and unknown spread shapes can force fallback behavior.

**Incorrect: dynamic shape that is hard to prove**

```tsx
function Badge(props: Record<string, unknown>, key: string) {
  const payload = { ...props, [key]: props[key] }
  return <span {...payload} />
}
```

**Correct: explicit fields or mergeProps boundary**

```tsx
import { mergeProps, prop } from 'fict'

function Badge(props: { label: string; active: boolean }) {
  const merged = mergeProps(
    { role: 'status' },
    {
      label: prop(() => props.label),
      active: prop(() => props.active),
    },
  )

  return <span aria-label={String(merged.label)} data-active={String(merged.active)} />
}
```

Reference: [https://github.com/fictjs/fict/blob/main/docs/architecture.md](https://github.com/fictjs/fict/blob/main/docs/architecture.md)

### 2.2 Prevent State Escape Outside Owning Scope

**Impact: CRITICAL (avoids lifecycle leaks and post-unmount writes)**

Never let a `$state` binding escape the component/hook scope that owns it.
Escaped mutable state can outlive lifecycle cleanup and produce invalid updates.

**Incorrect: state escapes owner**

```tsx
let inc: (() => void) | undefined

function Counter() {
  let count = $state(0)
  inc = () => count++
  return <div>{count}</div>
}

export function externalIncrement() {
  inc?.()
}
```

**Correct: keep ownership local or use shared primitives**

```tsx
import { createSignal } from 'fict/advanced'

const sharedCount = createSignal(0)

export function externalIncrement() {
  sharedCount(sharedCount() + 1)
}

function Counter() {
  return <div>{sharedCount()}</div>
}
```

Reference: [https://github.com/fictjs/fict/blob/main/docs/diagnostic-codes.md](https://github.com/fictjs/fict/blob/main/docs/diagnostic-codes.md)

### 2.3 Use Compiler-Derived Values Instead of Manual Snapshots

**Impact: CRITICAL (prevents stale reads and keeps reactive graph complete)**

When a value is derived from `$state`/`$store`, express it as a normal derived
binding (`const x = ...`) so Fict can track and memoize it. Avoid capturing a
one-time snapshot unless that behavior is intentional.

**Incorrect: stale snapshot**

```tsx
function Counter() {
  let count = $state(0)
  const doubled = count() * 2 // snapshot now, not a live derived binding

  $effect(() => {
    console.log(doubled)
  })

  return <button onClick={() => count++}>{doubled}</button>
}
```

**Correct: live derived binding**

```tsx
function Counter() {
  let count = $state(0)
  const doubled = count * 2

  $effect(() => {
    console.log(doubled)
  })

  return <button onClick={() => count++}>{doubled}</button>
}
```

Reference: [https://github.com/fictjs/fict/blob/main/docs/reactivity-semantics.md](https://github.com/fictjs/fict/blob/main/docs/reactivity-semantics.md)

---

## 3. Runtime Safety and Performance

**Impact: HIGH**

Avoid lifecycle leaks and unnecessary work while preserving fine-grained updates in runtime primitives.

### 3.1 Always Return Cleanup for Effectful Resources

**Impact: HIGH (prevents leaks and stale subscriptions during updates/unmount)**

Any `$effect` that creates subscriptions, timers, listeners, or async request
lifetimes should return cleanup. Missing cleanup is a common source of stale
work and memory growth.

**Incorrect: leaking listener and request**

```tsx
function Search({ query }: { query: string }) {
  let result = $state('')

  $effect(() => {
    window.addEventListener('resize', () => console.log('resize'))
    fetch(`/api/search?q=${query}`).then(async r => {
      result = await r.text()
    })
  })

  return <div>{result}</div>
}
```

**Correct: explicit cleanup and cancellation**

```tsx
function Search({ query }: { query: string }) {
  let result = $state('')

  $effect(() => {
    const onResize = () => console.log('resize')
    window.addEventListener('resize', onResize)

    const controller = new AbortController()
    fetch(`/api/search?q=${query}`, { signal: controller.signal })
      .then(async r => {
        result = await r.text()
      })
      .catch(() => {})

    return () => {
      window.removeEventListener('resize', onResize)
      controller.abort()
    }
  })

  return <div>{result}</div>
}
```

Reference: [https://github.com/fictjs/fict/blob/main/docs/api-reference.md](https://github.com/fictjs/fict/blob/main/docs/api-reference.md)

### 3.2 Keep Memo Computations Pure

**Impact: HIGH (avoids unpredictable re-execution side effects)**

Memo bodies (`$memo` or compiler-derived memo regions) must be pure. Side
effects inside memo computations can execute multiple times and violate
scheduling expectations.

**Incorrect: side effects in memo**

```tsx
function Counter() {
  let count = $state(0)

  const doubled = $memo(() => {
    console.log('tracking', count)
    localStorage.setItem('last', String(count))
    return count * 2
  })

  return <button onClick={() => count++}>{doubled}</button>
}
```

**Correct: pure memo + side effect in `$effect`**

```tsx
function Counter() {
  let count = $state(0)
  const doubled = count * 2

  $effect(() => {
    localStorage.setItem('last', String(count))
  })

  return <button onClick={() => count++}>{doubled}</button>
}
```

Reference: [https://github.com/fictjs/fict/blob/main/docs/diagnostic-codes.md](https://github.com/fictjs/fict/blob/main/docs/diagnostic-codes.md)

### 3.3 Use the Right Primitive for Shared State Boundaries

**Impact: HIGH (avoids accidental scope leaks and unnecessary recomputation)**

Use `$state` for component-local state only. For cross-component or module-level
state, prefer `$store` (deep object reactivity) or `createSignal` (scalar or
library-level signal).

**Incorrect: module-level `$state`**

```tsx
let globalCount = $state(0)

export function useGlobalCounter() {
  return {
    value: globalCount,
    inc: () => globalCount++,
  }
}
```

**Correct: shared primitives for shared ownership**

```tsx
import { $store } from 'fict'
import { createSignal } from 'fict/advanced'

export const session = $store({ user: null as null | { id: string } })
export const globalCount = createSignal(0)

export function useGlobalCounter() {
  return {
    value: globalCount,
    inc: () => globalCount(globalCount() + 1),
  }
}
```

Reference: [https://github.com/fictjs/fict/blob/main/docs/api-reference.md](https://github.com/fictjs/fict/blob/main/docs/api-reference.md)

---

## 4. SSR and Resume Stability

**Impact: HIGH**

Maintain SSR snapshot compatibility, resumable correctness, and predictable Suspense/resource behavior across server/client boundaries.

### 4.1 Key Async Resources and Place Suspense at Ownership Boundaries

**Impact: HIGH (avoids duplicate fetches and unstable suspend behavior)**

When using `resource` with route or prop parameters, provide a stable `key` and
wrap the owning UI region in `Suspense`. This keeps caching/retry behavior
predictable across SSR and client resume.

**Incorrect: unkeyed resource with unstable ownership**

```tsx
import { resource } from 'fict/plus'

function UserCard({ userId }: { userId: string }) {
  const user = resource({
    suspense: true,
    fetch: async () => fetch(`/api/users/${userId}`).then(r => r.json()),
  })

  return <div>{user.read().name}</div>
}
```

**Correct: explicit key and boundary**

```tsx
import { Suspense } from 'fict'
import { resource } from 'fict/plus'

function UserCard({ userId }: { userId: string }) {
  const user = resource({
    key: [userId],
    suspense: true,
    fetch: async ({ signal }) => fetch(`/api/users/${userId}`, { signal }).then(r => r.json()),
  })

  return (
    <Suspense fallback={<div>Loading user...</div>}>
      <div>{user.read().name}</div>
    </Suspense>
  )
}
```

Reference: [https://github.com/fictjs/fict/blob/main/docs/architecture.md](https://github.com/fictjs/fict/blob/main/docs/architecture.md)

### 4.2 Preserve Snapshot Schema and Loader Failure Semantics

**Impact: HIGH (protects resumability across deploys and mixed-version clients)**

Treat SSR snapshot payloads as versioned contracts. Keep `v` and `scopes` shape
compatible with `FICT_SSR_SNAPSHOT_SCHEMA_VERSION`, and wire loader issues to
telemetry using `onSnapshotIssue`.

**Incorrect: non-versioned custom snapshot payload**

```html
<script id="__FICT_SNAPSHOT__" type="application/json">
  { "state": { "foo": 1 } }
</script>
```

```ts
import { installResumableLoader } from '@fictjs/runtime/loader'

installResumableLoader()
```

**Correct: contract-compliant payload + issue reporting**

```html
<script id="__FICT_SNAPSHOT__" type="application/json">
  { "v": 1, "scopes": { "s1": { "id": "s1", "slots": [[0, "sig", 1]] } } }
</script>
```

```ts
import { installResumableLoader } from '@fictjs/runtime/loader'

installResumableLoader({
  onSnapshotIssue(issue) {
    console.error('[resume-issue]', issue.code, issue.message)
  },
})
```

Reference: [https://github.com/fictjs/fict/blob/main/docs/ssr-resume-stability-contract.md](https://github.com/fictjs/fict/blob/main/docs/ssr-resume-stability-contract.md)

---

## 5. Tooling and DX Boundaries

**Impact: MEDIUM**

Keep dev-only tooling useful without regressing production runtime behavior or bundle characteristics.

### 5.1 Isolate Playground Features from Runtime Core

**Impact: MEDIUM (prevents product tooling from regressing framework runtime path)**

Keep playground-only behavior in `@fictjs/playground` and integration adapters.
Do not import playground modules into runtime/compiler execution paths.

**Incorrect: runtime depends on playground code**

```ts
// packages/runtime/src/index.ts
import { startPlaygroundSession } from '@fictjs/playground'

export function bootRuntime() {
  startPlaygroundSession()
}
```

**Correct: optional integration boundary**

```ts
// packages/playground/src/runtime-adapter.ts
import { render } from 'fict'

export function mountPreview(view: () => unknown, el: HTMLElement) {
  render(view as never, el)
}
```

```ts
// packages/runtime/src/index.ts
export * from './public-runtime-api'
```

Reference: [https://github.com/fictjs/fict/blob/main/docs/architecture.md](https://github.com/fictjs/fict/blob/main/docs/architecture.md)

### 5.2 Keep DevTools Instrumentation Development-Only

**Impact: MEDIUM (preserves production runtime and bundle characteristics)**

Enable devtools only in development workflows. Keep production builds free of
debugging hooks and standalone panel routes.

**Incorrect: always-on devtools plugin**

```ts
import { defineConfig } from 'vite'
import fict from '@fictjs/vite-plugin'
import { fictDevTools } from '@fictjs/devtools'

export default defineConfig({
  plugins: [fict(), fictDevTools()],
})
```

**Correct: serve-only devtools plugin**

```ts
import { defineConfig } from 'vite'
import fict from '@fictjs/vite-plugin'
import { fictDevTools } from '@fictjs/devtools'

export default defineConfig(({ command }) => ({
  plugins: [fict(), command === 'serve' ? fictDevTools() : undefined].filter(Boolean),
}))
```

Reference: [https://github.com/fictjs/fict/blob/main/packages/devtools/README.md](https://github.com/fictjs/fict/blob/main/packages/devtools/README.md)

---

## 6. Verification and Release Discipline

**Impact: CRITICAL**

Every bug fix should be defended by regression tests and release gates to avoid silent correctness regressions.

### 6.1 Add Focused Regression Tests for Every Bug Fix

**Impact: CRITICAL (prevents repeated defects in compiler/runtime hot paths)**

Every defect fix should include a minimal failing test that reproduces the
original behavior and asserts the fix. Prefer precise, low-noise tests near the
affected package.

**Incorrect: fix without test**

```text
Fix merged after manual verification only.
No compiler/runtime test added.
```

**Correct: repro + assertion**

```ts
import { describe, expect, it } from 'vitest'
import { compile } from '@fictjs/compiler'

describe('regression: computed owner labeling', () => {
  it('does not count object-wrapper computed as user computed', () => {
    const out = compile(`
      function App() {
        let count = $state(0)
        const doubled = count * 2
        return <div>{doubled}</div>
      }
    `)

    expect(out.code).toContain('doubled')
    expect(out.diagnostics).toHaveLength(0)
  })
})
```

Reference: [https://github.com/fictjs/fict/blob/main/docs/strict-guarantee-test-policy.md](https://github.com/fictjs/fict/blob/main/docs/strict-guarantee-test-policy.md)

### 6.2 Run Compiler and Runtime Release Gates Before Merge

**Impact: CRITICAL (catches correctness and performance regressions before shipping)**

Use reproducible gate commands before merging compiler/runtime changes. A patch
is not release-ready until tests, type checks, strict diagnostics, and
performance guards all pass.

**Incorrect: partial verification**

```bash
pnpm --filter @fictjs/compiler test
```

**Correct: full gate sequence**

```bash
export BENCH_OUTPUT="${TMPDIR:-/tmp}/fict-optimizer-bench.json"
pnpm release:verify
```

Reference: [https://github.com/fictjs/fict/blob/main/package.json](https://github.com/fictjs/fict/blob/main/package.json)

---

## References

1. [https://github.com/fictjs/fict/blob/main/README.md](https://github.com/fictjs/fict/blob/main/README.md)
2. [https://github.com/fictjs/fict/blob/main/docs/architecture.md](https://github.com/fictjs/fict/blob/main/docs/architecture.md)
3. [https://github.com/fictjs/fict/blob/main/docs/reactivity-semantics.md](https://github.com/fictjs/fict/blob/main/docs/reactivity-semantics.md)
4. [https://github.com/fictjs/fict/blob/main/docs/reactivity-guarantee-matrix.md](https://github.com/fictjs/fict/blob/main/docs/reactivity-guarantee-matrix.md)
5. [https://github.com/fictjs/fict/blob/main/docs/diagnostic-codes.md](https://github.com/fictjs/fict/blob/main/docs/diagnostic-codes.md)
6. [https://github.com/fictjs/fict/blob/main/docs/ssr-resume-stability-contract.md](https://github.com/fictjs/fict/blob/main/docs/ssr-resume-stability-contract.md)
7. [https://github.com/fictjs/fict/blob/main/docs/strict-guarantee-test-policy.md](https://github.com/fictjs/fict/blob/main/docs/strict-guarantee-test-policy.md)
