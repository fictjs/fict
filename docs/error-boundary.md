# Error Handling & ErrorBoundary (Runtime)

This note documents the runtime semantics for error capture in Fict 1.0.

## What is caught

- **Render**: Component/function execution (including compiler-generated child bindings) throws → nearest `ErrorBoundary` renders `fallback`.
- **Events**: JSX event handlers are wrapped; thrown errors route to the nearest boundary.
- **Effects**: Errors from `createEffect` handlers route to the nearest boundary.
- **Cleanup**: Lifecycle cleanups throwing errors route to the nearest boundary.

If no boundary handles the error (handler returns `false` or there is no boundary), the error is re-thrown.

## SSR semantics

- `renderToString` / `renderToDocument`: captured render errors produce fallback HTML directly.
- `renderToStream` (`mode: 'shell'`):
  - handled errors keep streaming active and complete normally;
  - unhandled async errors (for example Suspense token rejection without a boundary) trigger `onError` and abort the stream.
- `renderToStream` (`mode: 'all'`): unhandled errors reject readiness and abort output.

## ErrorBoundary API

```tsx
<ErrorBoundary
  fallback={err => <p>Oops: {String(err)}</p>}
  onError={err => report(err)}
  resetKeys={() => versionSignal()}
>
  <Child />
</ErrorBoundary>
```

- `fallback`: node or `(err) => node` shown after first captured error.
- `onError`: optional hook invoked when an error is captured.
- `resetKeys`: value or getter; change triggers error reset and subtree rebuild.
- Nearest boundary wins; errors do not bubble past a boundary that returns `true`.

## Notes for compiler/runtime

- Event, effect, and child-render paths must call `handleError` with appropriate `source` metadata.
- Cleanup errors should also go through `handleError`; only rethrow if unhandled.
- Boundaries manage their own root for child rendering; switching to fallback disposes the previous child root.
