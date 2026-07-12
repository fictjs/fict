# API Reference

Fict splits its public surface into three import paths. Choose the narrowest stable entry point for the job.

## `fict`

The main application API:

| Area                   | APIs                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| Compiler macros        | [`$state`](/api/state), [`$effect`](/api/effect)                                              |
| Derived and deep state | `$memo`, `createMemo`, `createEffect`, [`$store`](/api/store)                                 |
| Lifecycle              | [`onMount`](/api/on-mount), [`onDestroy`](/api/on-destroy), `onCleanup`, `createRoot`         |
| Rendering              | `render`, `Fragment`, `createPortal`, `createRef`                                             |
| Boundaries             | `Suspense`, `ErrorBoundary`                                                                   |
| Scheduling             | `batch`, `untrack`, [`startTransition`, `useTransition`, `useDeferredValue`](/api/transition) |
| Props                  | `prop`, `mergeProps`, `keyed`                                                                 |

## `fict/plus`

Async and code-splitting utilities:

| API                         | Purpose                                               |
| --------------------------- | ----------------------------------------------------- |
| [`resource`](/api/resource) | Cached, cancellable async data with optional Suspense |
| `lazy`                      | Lazy component loading                                |

`$store` and `$memo` are still re-exported here for compatibility, but new code should import them from `fict`.

## `fict/advanced`

Escape hatches and library-building primitives:

| API                                                          | Purpose                                          |
| ------------------------------------------------------------ | ------------------------------------------------ |
| [`createSignal`](/api/signal)                                | Shared scalar or low-level reactive cell         |
| `createRenderEffect`                                         | Low-level render-effect primitive                |
| [`createContext`, `useContext`, `hasContext`](/api/context)  | Scoped dependency injection                      |
| `reactive`, `nonReactive`, `unwrap`                          | Explicit reactive getter boundaries              |
| `createSelector`, `createScope`, `runInScope`, `effectScope` | Fine-grained subscription and ownership controls |

Application components normally need only `fict` plus `resource` or `lazy` from `fict/plus`.

## Compiler requirement

`$state` and `$effect` are compile-time macros. Use `@fictjs/vite-plugin`, `@fictjs/webpack-plugin`, or another supported Fict compiler integration. If uncompiled code reaches the runtime macro stubs, Fict throws an explicit diagnostic.

## Source of truth

Exports are defined by `packages/fict/src/index.ts`, `packages/fict/src/plus.ts`, `packages/fict/src/advanced.ts`, and `packages/runtime/src/index.ts`. Published subpaths are declared in `packages/fict/package.json`.
