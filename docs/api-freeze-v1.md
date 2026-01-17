# Fict v1.0 API Freeze Specification

This document explicitly defines the Fict v1.0 public API surface, including runtime exports and compiler-dependent helpers. Once released, these APIs will remain backward compatible for at least one major version (v1.x → v2.0).

## Table of Contents

- [API Stability Levels](#api-stability-levels)
- [1. Public User API (Tier 1 - Must Freeze)](#1-public-user-api-tier-1---must-freeze)
- [2. Compiler-Dependent API (Tier 2 - Internally Stable)](#2-compiler-dependent-api-tier-2---internally-stable)
- [3. Advanced/Extended API (Tier 3 - Optionally Frozen)](#3-advancedextended-api-tier-3---optionally-frozen)
- [4. Internal Implementation API (Not Frozen)](#4-internal-implementation-api-not-frozen)
- [5. Type Definitions (Must Freeze)](#5-type-definitions-must-freeze)
- [6. Compatibility Commitment](#6-compatibility-commitment)
- [7. Deprecation Policy](#7-deprecation-policy)

---

## API Stability Levels

| Level      | Marker          | Meaning                                | Change Policy                               |
| ---------- | --------------- | -------------------------------------- | ------------------------------------------- |
| **Tier 1** | `@public`       | User-facing public API                 | Frozen, no breaking changes                 |
| **Tier 2** | `@internal`     | Helpers depended on by compiler output | Signature stable, implementation may change |
| **Tier 3** | `@advanced`     | Advanced/extension APIs                | Keep stable when possible                   |
| **Tier 4** | `@experimental` | Experimental features                  | May change at any time                      |

---

## 1. Public User API (Tier 1 - Must Freeze)

These APIs are core interfaces used directly by users and must remain fully backward compatible across v1.x.

### 1.1 Reactivity Core

```typescript
// Source: @fictjs/runtime

// Computed/derived values
export function createMemo<T>(fn: () => T): Memo<T>
export type Memo<T> = () => T

// Effects
export function createEffect(fn: () => void | Cleanup): Cleanup
export type Effect = () => void | Cleanup

// Scheduling control
export function batch<T>(fn: () => T): T
export function untrack<T>(fn: () => T): T

// Transition API (priority scheduling)
export function startTransition(fn: () => void): void
export function useTransition(): [pending: () => boolean, start: (fn: () => void) => void]
export function useDeferredValue<T>(value: () => T): () => T
```

### 1.1.1 Deep Reactive Store

```typescript
// Source: fict (main entry)

// $store - deep reactive proxy object (recommended for users)
export function $store<T extends object>(initialValue: T): T
```

> **Note**: `createStore` is internal and returns `[store, setStore]` with reconcile-based updates. Regular users only need `$store`.

### 1.2 Lifecycle

```typescript
// Mount/teardown hooks
export function onMount(fn: () => void | Cleanup): void
export function onDestroy(fn: () => void): void
export function onCleanup(fn: () => void): void

// Root context
export function createRoot<T>(
  fn: () => T,
  options?: { inherit?: boolean },
): { value: T; dispose: () => void }
```

### 1.3 DOM Rendering

```typescript
// Main render entry
export function render(view: () => FictNode, container: HTMLElement): () => void

// Element creation (normally compiler-generated)
export function createElement(node: FictNode): Node
```

> **Note**: `template(html: string): () => Node` is exported from `@fictjs/runtime/internal` for compiler use only.

### 1.4 Components

```typescript
// Fragment
export const Fragment: unique symbol

// Error boundary
export function ErrorBoundary(props: {
  fallback: (error: Error, reset: () => void) => FictNode
  children: FictNode
}): FictNode

// Suspense
export function Suspense(props: { fallback?: FictNode; children: FictNode }): FictNode

export function createSuspenseToken(): SuspenseToken
```

### 1.5 Ref

```typescript
export function createRef<T extends Element = HTMLElement>(): RefObject<T>

export interface RefObject<T> {
  current: T | null
}

export type RefCallback<T> = (element: T) => void
export type Ref<T> = RefCallback<T> | RefObject<T>
```

### 1.6 Reactive Scopes

```typescript
export function createScope(): ReactiveScope
export function runInScope<T>(flag: () => boolean, fn: () => T): T
export function effectScope<T>(fn: () => T): { value: T; stop: () => void }

export interface ReactiveScope {
  run<T>(fn: () => T): T
  stop(): void
  active: boolean
}
```

### 1.7 Props Utilities

```typescript
// Merge multiple props objects (preserves reactivity)
export function mergeProps<T extends object[]>(...sources: T): MergedProps<T>

// Mark reactive prop getter (with memoization)
export function prop<T>(getter: () => T, options?: { unwrap?: boolean }): () => T
```

> **Simplified**: Props utilities are reduced to two core functions:
>
> - `mergeProps()` - merge props objects
> - `prop()` - mark reactive getter (auto memoized)
>
> `createPropsProxy` has moved to internal, `useProp` has been removed.

### 1.9 Context API

```typescript
// Source: @fictjs/runtime (also exported from advanced)

// Create context
export function createContext<T>(defaultValue: T): Context<T>

// Get context value
export function useContext<T>(context: Context<T>): T

// Check whether a context exists
export function hasContext<T>(context: Context<T>): boolean

export interface Context<T> {
  readonly id: symbol
  readonly defaultValue: T
  Provider: ContextProvider<T>
  displayName?: string
}

export interface ProviderProps<T> extends BaseProps {
  value: T
}
```

> **Purpose**: The Context API passes data across component trees, supporting SSR isolation, multiple instances, and subtree overrides.

### 1.10 Versioned Signals

```typescript
export function createVersionedSignal<T>(
  initial: T,
  options?: VersionedSignalOptions<T>,
): VersionedSignal<T>

export interface VersionedSignal<T> {
  (): T
  set(value: T | ((prev: T) => T)): void
  version: () => number
}

export interface VersionedSignalOptions<T> {
  equals?: (a: T, b: T) => boolean
}
```

---

## 2. Compiler-Dependent API (Tier 2 - Internally Stable)

These APIs are invoked by compiler-generated code. Although marked as internal, their **signatures and behavior must remain stable** because compiled user code depends on them. Implementation details may change, but interfaces may not.

### 2.1 Compiler Helper Functions

```typescript
// Module: @fictjs/runtime
// Note: These functions use a __ prefix to mark internal API

// ============================================================================
// Hook context management (for component state tracking)
// ============================================================================

export function __fictUseContext(): HookContext
export function __fictPushContext(): void
export function __fictPopContext(): void
export function __fictResetContext(): void

// ============================================================================
// Hook primitives (compiler emits these for hooks)
// ============================================================================

export function __fictUseSignal<T>(slot: number, initialValue: T): Signal<T>
export function __fictUseMemo<T>(slot: number, fn: () => T): Memo<T>
export function __fictUseEffect(slot: number, fn: () => void | Cleanup): void

// ============================================================================
// Rendering helpers
// ============================================================================

export function __fictRender<T>(fn: () => T): T

// ============================================================================
// Props access (keep props destructuring reactive)
// ============================================================================

export function __fictProp<T, K extends keyof T>(obj: T, key: K, defaultValue?: T[K]): () => T[K]

export function __fictPropsRest<T extends object, K extends keyof T>(obj: T, keys: K[]): Omit<T, K>
```

### 2.2 DOM Binding Functions

```typescript
// ============================================================================
// Core bindings (compiler-generated JSX transforms depend on these)
// ============================================================================

// Text binding
export function bindText(node: Text, accessor: MaybeReactive<any>): void

// Attribute binding
export function bindAttribute(el: Element, attr: string, accessor: MaybeReactive<any>): void

// Property binding (e.g., value, checked)
export function bindProperty(el: Element, prop: string, accessor: MaybeReactive<any>): void

// Class binding
export function bindClass(el: Element, accessor: MaybeReactive<ClassProp>): void

// Style binding
export function bindStyle(el: Element, accessor: MaybeReactive<StyleProp>): void

// Event binding
export function bindEvent(
  el: Element,
  eventName: string,
  handler: EventHandler,
  options?: AddEventListenerOptions,
): void

// Ref binding
export function bindRef(el: Element, ref: Ref<any>): void

// Event handler invocation (supports event delegation)
export function callEventHandler(
  handler: EventHandler | null | undefined,
  event: Event,
  node?: EventTarget | null,
  data?: unknown,
): void

// ============================================================================
// Advanced bindings
// ============================================================================

// Conditional rendering
export function createConditional(
  condition: () => boolean,
  consequent: () => FictNode,
  alternate?: () => FictNode,
): BindingHandle

// Portal
export function createPortal(children: () => FictNode, target: Element | string): BindingHandle

// Show (conditional rendering that preserves DOM)
export function createShow(when: () => boolean, children: () => FictNode): BindingHandle

// Child insertion
export function insert(parent: Node, accessor: MaybeReactive<FictNode>, marker?: Node): void
```

### 2.3 List Rendering

```typescript
// Keyed lists (compiler emits for array.map)
export function createKeyedList(
  accessor: () => any[],
  mapFn: (item: any, index: () => number) => FictNode,
  keyFn?: (item: any, index: number) => any,
): BindingHandle

export interface KeyedListBinding extends BindingHandle {
  nodes: Node[][]
  keys: any[]
}

// DOM primitives
export function toNodeArray(nodes: FictNode): Node[]
export function moveNodesBefore(nodes: Node[], target: Node): void
export function removeNodes(nodes: Node[]): void
export function insertNodesBefore(nodes: Node[], target: Node): void
```

### 2.4 Event Delegation

```typescript
// Initialize event delegation (emitted at module top level)
export function delegateEvents(eventNames: string[], document?: Document): void

// Clean up delegated events
export function clearDelegatedEvents(document?: Document): void

// Low-level event listener
export function addEventListener(
  el: Element,
  eventName: string,
  handler: EventHandler,
  options?: AddEventListenerOptions,
): Cleanup
```

### 2.5 Spread Props

```typescript
// Spread props onto element
export function spread<T extends Element>(el: T, props: MaybeReactive<Record<string, any>>): void

// Assign props to element (non-reactive)
export function assign<T extends Element>(el: T, props: Record<string, any>): void

// classList helper
export function classList(el: Element, classes: MaybeReactive<ClassProp>): void
```

### 2.6 Constants Referenced by the Compiler

These constants are shared between compiler and runtime for consistent DOM handling. **Only exported from `@fictjs/runtime/internal`**, not part of the public API:

```typescript
// Source: @fictjs/runtime/internal

// Attributes that should use DOM property instead of attribute
export const Properties: Set<string>

// Child-related properties that should be set via property
export const ChildProperties: Set<string>

// Attribute name aliases (e.g., className -> class)
export const Aliases: Record<string, string>
export function getPropAlias(name: string): string

// Boolean attributes (presence implies true)
export const BooleanAttributes: Set<string>

// SVG element names
export const SVGElements: Set<string>

// SVG namespace URI
export const SVGNamespace: string

// Events using delegation
export const DelegatedEvents: Set<string>

// CSS properties that do not need units
export const UnitlessStyles: Set<string>
```

---

## 3. Advanced/Extended API (Tier 3 - Optionally Frozen)

These APIs target advanced use cases. We aim to keep them stable but minor non-breaking changes may occur in patch/minor releases.

### 3.0 Advanced Reactive Primitives

```typescript
// Source: @fictjs/runtime/advanced

// Signals - shared scalar/lightweight values across components (escape hatch)
export function createSignal<T>(initialValue: T): Signal<T>
export type Signal<T> = [get: () => T, set: (v: T | ((prev: T) => T)) => void]

// Selector - fine-grained subscription optimization
export function createSelector<T, U = T>(
  source: () => T,
  fn?: (a: U, b: T) => boolean,
): (key: U) => boolean

// Effect scope - collect effects for batch disposal
export function effectScope<T>(fn: () => T): { value: T; stop: () => void }

// Render effect - synchronous effect for DOM updates
export function createRenderEffect(fn: () => void | Cleanup): () => void
```

> **Note**: `createSignal` is an escape-hatch API, only for:
>
> - Module-level shared state
> - Custom hooks that must return a signal
> - Utility libraries / non-component code
>
> Prefer `$state` inside components; use `$store` for deep shared objects across components.

### 3.1 Binding Creation Helpers

```typescript
// Create text node binding (returns handle)
export function createTextBinding(node: Text, accessor: MaybeReactive<any>): BindingHandle

// Create child binding
export function createChildBinding(
  parent: Node,
  accessor: MaybeReactive<FictNode>,
  marker?: Node,
): BindingHandle

// Create attribute binding
export function createAttributeBinding(
  el: Element,
  attr: string,
  accessor: MaybeReactive<any>,
): BindingHandle

// Create style binding
export function createStyleBinding(el: Element, accessor: MaybeReactive<StyleProp>): BindingHandle

// Create class binding
export function createClassBinding(el: Element, accessor: MaybeReactive<ClassProp>): BindingHandle
```

### 3.2 Utility Functions

```typescript
// Check if a value is reactive (getter function)
export function isReactive(value: unknown): value is () => unknown

// Unwrap reactive value
export function unwrap<T>(value: MaybeReactive<T>): T

// Array reconciliation algorithm
export function reconcileArrays<T>(
  parent: Node,
  current: T[],
  next: T[],
  createFn: (item: T) => Node,
  beforeNode?: Node,
): void
```

### 3.3 Debug/Dev Tools

```typescript
// DevTools hook (dev mode only)
export function getDevtoolsHook(): FictDevtoolsHook | undefined

export interface FictDevtoolsHook {
  onSignalCreate?(signal: SignalNode): void
  onSignalUpdate?(signal: SignalNode, oldValue: unknown, newValue: unknown): void
  onEffectCreate?(effect: EffectNode): void
  onEffectRun?(effect: EffectNode): void
  onComponentMount?(name: string, props: unknown): void
  onComponentUnmount?(name: string): void
}

// Cycle protection configuration
export function setCycleProtectionOptions(options: {
  maxIterations?: number
  onCycleDetected?: (info: CycleInfo) => void
}): void
```

---

## 4. Internal Implementation API (Not Frozen)

The following APIs are considered internal implementation details and **are not guaranteed** to be compatible across versions:

```typescript
// Internal reactive node types (subject to change)
interface SignalNode<T> {
  /* internal implementation */
}
interface ComputedNode<T> {
  /* internal implementation */
}
interface EffectNode {
  /* internal implementation */
}
interface EffectScopeNode {
  /* internal implementation */
}

// Internal linking structures (subject to change)
interface Link {
  /* internal implementation */
}

// Lifecycle context (subject to change)
interface RootContext {
  /* internal implementation */
}

// Scheduler internals (subject to change)
// flush, scheduleMicroTask, queueEffect, etc.
```

---

## 5. Type Definitions (Must Freeze)

### 5.1 Core Types

```typescript
// Virtual node
export interface FictVNode {
  type: string | symbol | Component
  props: Record<string, unknown> | null
  key?: string | undefined
}

// Renderable node
export type FictNode = FictVNode | FictNode[] | Node | string | number | boolean | null | undefined

// DOM element
export type DOMElement = Node

// Cleanup function
export type Cleanup = () => void

// Component type
export type Component<P = {}> = (props: P & BaseProps) => FictNode

export interface BaseProps {
  key?: string | number
  children?: FictNode | FictNode[]
}

export type PropsWithChildren<P = {}> = P & {
  children?: FictNode | FictNode[]
}
```

### 5.2 Reactive Types

```typescript
// Maybe reactive value
export type MaybeReactive<T> = T | (() => T)

// Binding handle
export interface BindingHandle {
  marker: Comment | DocumentFragment
  flush?: () => void
  dispose: Cleanup
}
```

### 5.3 Style and Class Names

```typescript
export type StyleValue = string | number
export type CSSStyleObject = Record<string, StyleValue>
export type StyleProp = string | CSSStyleObject | null | undefined

export type ClassObject = Record<string, boolean | undefined | null>
export type ClassProp = string | ClassObject | null | undefined
```

### 5.4 Event Handling

```typescript
export type EventHandler<E extends Event = Event> = (event: E) => void

export interface ErrorInfo {
  source: 'render' | 'effect' | 'event' | 'renderChild' | 'cleanup'
  componentName?: string
  eventName?: string
}
```

### 5.5 Suspense

```typescript
export interface SuspenseToken {
  then: Promise<unknown>['then']
}
```

---

## 6. Compatibility Commitment

### v1.x Guarantees

1.  **Tier 1 API**: Signatures unchanged, behavior unchanged
2.  **Tier 2 API**: Signatures unchanged, internals may be optimized
3.  **Tier 3 API**: Kept stable when possible; changes will be noted in CHANGELOG
4.  **Type definitions**: Public types remain unchanged; internal types may expand

### Compiler Output Compatibility

- Code emitted by the v1.x compiler **must** run on all v1.x runtimes
- Newer runtimes may support older compiler output
- Compiler and runtime versions should match for best performance

---

## 7. Deprecation Policy

### Deprecation Process

1.  **Mark deprecated**: Use `@deprecated` JSDoc tag
2.  **Console warning**: Warn on first use in development mode
3.  **Documentation update**: Note in CHANGELOG and migration guide
4.  **Removal timeline**: Earliest removal in the next major (v2.0)

### Example

```typescript
/**
 * @deprecated Use createMemo instead
 * Will be removed in v2.0
 */
export const $memo = createMemo
```

---

## Appendix: API Export Matrix

### `fict` / `@fictjs/runtime` Main Entry

| Export                      | Category   | Tier | Compiler Dependent |
| --------------------------- | ---------- | ---- | ------------------ |
| `createMemo`                | Reactivity | 1    | Yes                |
| `createEffect`              | Reactivity | 1    | Yes                |
| `batch`                     | Scheduling | 1    | No                 |
| `untrack`                   | Scheduling | 1    | No                 |
| `startTransition`           | Scheduling | 1    | No                 |
| `useTransition`             | Scheduling | 1    | No                 |
| `useDeferredValue`          | Scheduling | 1    | No                 |
| `onMount`                   | Lifecycle  | 1    | No                 |
| `onDestroy`                 | Lifecycle  | 1    | Yes                |
| `onCleanup`                 | Lifecycle  | 1    | No                 |
| `createRoot`                | Lifecycle  | 1    | No                 |
| `createRef`                 | Ref        | 1    | No                 |
| `render`                    | DOM        | 1    | No                 |
| `createElement`             | DOM        | 1    | Yes                |
| `createPortal`              | DOM        | 1    | No                 |
| `Fragment`                  | JSX        | 1    | Yes                |
| `ErrorBoundary`             | Component  | 1    | No                 |
| `Suspense`                  | Component  | 1    | No                 |
| `createSuspenseToken`       | Component  | 1    | No                 |
| `createContext`             | Context    | 1    | No                 |
| `useContext`                | Context    | 1    | No                 |
| `hasContext`                | Context    | 1    | No                 |
| `mergeProps`                | Props      | 1    | Yes                |
| `prop`                      | Props      | 1    | Yes                |
| `__fictProp`                | Internal   | 2    | Yes                |
| `__fictPropsRest`           | Internal   | 2    | Yes                |
| `__fictUseContext`          | Internal   | 2    | Yes                |
| `__fictPushContext`         | Internal   | 2    | Yes                |
| `__fictPopContext`          | Internal   | 2    | Yes                |
| `__fictUseSignal`           | Internal   | 2    | Yes                |
| `__fictUseMemo`             | Internal   | 2    | Yes                |
| `__fictUseEffect`           | Internal   | 2    | Yes                |
| `__fictRender`              | Internal   | 2    | Yes                |
| `__fictResetContext`        | Internal   | 2    | Yes                |
| `bindText`                  | Binding    | 2    | Yes                |
| `bindAttribute`             | Binding    | 2    | Yes                |
| `bindProperty`              | Binding    | 2    | Yes                |
| `bindClass`                 | Binding    | 2    | Yes                |
| `bindStyle`                 | Binding    | 2    | Yes                |
| `bindEvent`                 | Binding    | 2    | Yes                |
| `bindRef`                   | Binding    | 2    | Yes                |
| `callEventHandler`          | Binding    | 2    | Yes                |
| `insert`                    | Binding    | 2    | Yes                |
| `createConditional`         | Binding    | 2    | Yes                |
| `createKeyedList`           | List       | 2    | Yes                |
| `toNodeArray`               | List       | 2    | Yes                |
| `delegateEvents`            | Events     | 2    | Yes                |
| `spread`                    | Props      | 2    | No                 |
| `assign`                    | Props      | 2    | No                 |
| `classList`                 | Binding    | 2    | No                 |
| `createTextBinding`         | Binding    | 3    | No                 |
| `createChildBinding`        | Binding    | 3    | No                 |
| `createAttributeBinding`    | Binding    | 3    | No                 |
| `createStyleBinding`        | Binding    | 3    | No                 |
| `createClassBinding`        | Binding    | 3    | No                 |
| `createShow`                | Binding    | 3    | No                 |
| `isReactive`                | Utility    | 3    | No                 |
| `unwrap`                    | Utility    | 3    | No                 |
| `getDevtoolsHook`           | Debug      | 3    | No                 |
| `setCycleProtectionOptions` | Debug      | 3    | No                 |

### `@fictjs/runtime/advanced` (Advanced API)

| Export                      | Category   | Tier | Notes                        |
| --------------------------- | ---------- | ---- | ---------------------------- |
| `createSignal`              | Reactivity | 3    | Cross-component escape hatch |
| `createSelector`            | Reactivity | 3    | Fine-grained subscription    |
| `createScope`               | Scope      | 3    | Reactive scope management    |
| `runInScope`                | Scope      | 3    | Execute in scope             |
| `effectScope`               | Scope      | 3    | Effect scope                 |
| `createContext`             | Context    | 3    | Also in main entry           |
| `useContext`                | Context    | 3    | Also in main entry           |
| `hasContext`                | Context    | 3    | Also in main entry           |
| `createVersionedSignal`     | Reactivity | 3    | Versioned signal             |
| `createTextBinding`         | Binding    | 3    | Advanced binding             |
| `createChildBinding`        | Binding    | 3    | Advanced binding             |
| `createAttributeBinding`    | Binding    | 3    | Advanced binding             |
| `createStyleBinding`        | Binding    | 3    | Advanced binding             |
| `createClassBinding`        | Binding    | 3    | Advanced binding             |
| `createShow`                | Binding    | 3    | Advanced binding             |
| `isReactive`                | Utility    | 3    | Detect reactive value        |
| `unwrap`                    | Utility    | 3    | Unwrap reactive value        |
| `getDevtoolsHook`           | Debug      | 3    | DevTools hook                |
| `setCycleProtectionOptions` | Debug      | 3    | Cycle protection config      |
| `createRenderEffect`        | Effect     | 3    | Render effect                |

### `@fictjs/runtime/internal` (Compiler/Internal Use)

| Export              | Category   | Tier | Notes                                               |
| ------------------- | ---------- | ---- | --------------------------------------------------- |
| `createStore`       | Reactivity | 2    | Deep proxy + setStore reconciliation; internal-only |
| `createPropsProxy`  | Props      | 2    | Internal props proxy                                |
| `Properties`        | Constants  | 2    | DOM property list                                   |
| `ChildProperties`   | Constants  | 2    | Child property list                                 |
| `Aliases`           | Constants  | 2    | Attribute alias map                                 |
| `getPropAlias`      | Constants  | 2    | Get attribute alias                                 |
| `BooleanAttributes` | Constants  | 2    | Boolean attribute list                              |
| `SVGElements`       | Constants  | 2    | SVG element list                                    |
| `SVGNamespace`      | Constants  | 2    | SVG namespace                                       |
| `DelegatedEvents`   | Constants  | 2    | Delegated event list                                |
| `UnitlessStyles`    | Constants  | 2    | Unitless style list                                 |

### `fict/jsx-runtime`

| Export     | Category | Tier |
| ---------- | -------- | ---- |
| `jsx`      | JSX      | 1    |
| `jsxs`     | JSX      | 1    |
| `Fragment` | JSX      | 1    |

### `fict/jsx-dev-runtime`

| Export     | Category | Tier |
| ---------- | -------- | ---- |
| `jsxDEV`   | JSX      | 1    |
| `Fragment` | JSX      | 1    |

### Additional `fict` Main Entry Exports

| Export           | Category   | Tier | Notes                     |
| ---------------- | ---------- | ---- | ------------------------- |
| `$store`         | Store      | 1    | Deep reactive store       |
| `$memo`          | Reactivity | 1    | Alias of createMemo       |
| `createSelector` | Reactivity | 1    | Convenience from advanced |
| `createScope`    | Reactivity | 1    | Convenience from advanced |
| `runInScope`     | Reactivity | 1    | Convenience from advanced |

### `fict/plus`

| Export     | Category  | Tier |
| ---------- | --------- | ---- |
| `resource` | Async     | 1    |
| `lazy`     | Lazy load | 1    |

#### `fict/plus` Detailed Type Definitions

```typescript
// ============================================================================
// $store - deep reactive proxy
// ============================================================================

/**
 * Create a deep reactive proxy object.
 * Unlike createStore (internal), $store returns the proxy directly with no setter.
 */
export function $store<T extends object>(initialValue: T): T

// ============================================================================
// resource - async resource management
// ============================================================================

export interface ResourceResult<T> {
  /** Get data (throws promise when suspense is enabled and not loaded) */
  readonly data: T | undefined
  /** Whether loading */
  readonly loading: boolean
  /** Load error */
  readonly error: unknown
  /** Manually refresh data */
  refresh: () => void
}

export interface ResourceCacheOptions {
  /** Cache mode: 'memory' uses memory cache; 'none' disables cache */
  mode?: 'memory' | 'none'
  /** Cache TTL in milliseconds */
  ttlMs?: number
  /** Serve stale data while refreshing in background */
  staleWhileRevalidate?: boolean
  /** Whether to cache error results */
  cacheErrors?: boolean
}

export interface ResourceOptions<T, Args> {
  /** Custom cache key (value or function) */
  key?: unknown | ((args: Args) => unknown)
  /** Async fetcher */
  fetch: (ctx: { signal: AbortSignal }, args: Args) => Promise<T>
  /** Enable Suspense mode */
  suspense?: boolean
  /** Cache config */
  cache?: ResourceCacheOptions
  /** Reset token (forces refresh on change) */
  reset?: unknown | (() => unknown)
}

export interface Resource<T, Args> {
  /** Read resource (reactive) */
  read(args: (() => Args) | Args): ResourceResult<T>
  /** Invalidate cache */
  invalidate(key?: unknown): void
  /** Prefetch data */
  prefetch(args: Args, keyOverride?: unknown): void
}

/**
 * Create an async resource
 */
export function resource<T, Args = void>(
  optionsOrFetcher:
    | ((ctx: { signal: AbortSignal }, args: Args) => Promise<T>)
    | ResourceOptions<T, Args>,
): Resource<T, Args>

// ============================================================================
// lazy - lazy load component
// ============================================================================

export interface LazyModule<TProps extends Record<string, unknown>> {
  default: Component<TProps>
}

/**
 * Create a lazy-loaded component (used with Suspense)
 */
export function lazy<TProps extends Record<string, unknown> = Record<string, unknown>>(
  loader: () => Promise<LazyModule<TProps> | { default: Component<TProps> }>,
): Component<TProps>
```

---

## Changelog

- **2026-01-11**: API tier adjustments
  - `createSignal` moved to `@fictjs/runtime/advanced` (escape hatch)
  - Added Context API (`createContext`, `useContext`, `hasContext`)
  - Removed `useProp`
  - Added `@fictjs/runtime/advanced` export table
- **2025-01-10**: Initial API freeze specification created
