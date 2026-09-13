# Explicit async declarations

`$async` creates an owned async computation and exposes its **resolved value** to
compiled code. Import it by name from `fict` or `fict/slim`; declare one `const` at
the top level of a component, hook, or module. Ordinary Promise-valued memos keep
their existing behavior. The compiler never infers unwrapping from a return type.

```tsx
import { $async, $state, Suspense } from 'fict'

async function fetchLabel(id: number, signal: AbortSignal) {
  const response = await fetch(`/api/items/${id}`, { signal })
  if (!response.ok) throw new Error(`Request failed: ${response.status}`)
  return response.text()
}

export function Item() {
  let id = $state(1)
  const label = $async(context => fetchLabel(id, context.signal))
  return (
    <section>
      <button onClick={() => id++}>Next</button>
      <Suspense fallback={<span>Loading…</span>}>
        <span>{label}</span>
      </Suspense>
    </section>
  )
}
```

The synchronous producer captures `id` as an input. Changing it invalidates the
node and starts a new generation when consumed. Replacement and disposal abort
the old generation, and old completions cannot publish. The same readiness state
propagates through ordinary derived values, DOM bindings, effects, Suspense and
causal transitions. The result can also be synchronous or an `AsyncIterable`.
Successful `undefined` and a function are valid values: `fn(argument)` calls the
resolved function, and object method calls retain their receiver.

The producer receives `context.signal` and a discriminated previous-value view:
`hasValue: false` with `previous: undefined`, or `hasValue: true` with the last
successful value. Returning a new generation does not require external loading,
error or version signals. See the [graph contract](./async-graph-contract.md) for
readiness, error, stale-value, cleanup and transition rules.

## Continuations and ownership

`$async` requires exactly one statically known **synchronous** producer. Put native
`await` or `yield` in an ordinary helper receiving captured inputs, as above.
Native continuations do not inherit dependency tracking or a render context.
Computations created synchronously inside a producer use its generation owner,
not component hook slots. Create async dependencies and Resources outside the
producer: recreating a pending child on every replay would prevent it from ever
becoming available. Direct nested construction reports `FICT-ASYNC-NESTED`.
Read an existing async dependency or return composed Promises instead.
The compiler rejects an async/generator producer instead of implying that reads
after suspension will restart it. Capturing a reactive closure for an unknown
host still triggers the existing escape diagnostics. Passing a mutable state
object to an opaque fetch helper still needs a separate boundary proof.

The producer's synchronous argument boundary accepts proven primitive
component-local inputs. It does not make mutable object identities or retained
callbacks into snapshots. An arbitrary imported hook's output is not necessarily
a proven primitive; use its declared contract or an explicit supported boundary.

Results are read-only. Change producer inputs to refresh a declaration. Use
`createAsyncMemo` from `fict/advanced` when you need an accessor with `state()`,
`latest()`, `refresh()` and `dispose()`. That API keeps its callable object and
methods through immutable aliases and hook metadata. Its runtime contract also
tracks only synchronous producer reads; compiled reactive captures in native
async callbacks remain a strict boundary.

Read pending values inside reactive consumers such as JSX bindings. A pending
read in synchronous component setup cannot resume that function midway; move the
read into a binding or an explicit prepare/commit consumer. Async component
functions remain unsupported. A module-level declaration has module lifetime;
prefer a hook/component for request or view ownership, and the manual API when an
explicit disposer is required.

Preview resumability cannot serialize async readiness, generations or transport
ownership. Enabling that unfrozen ABI with async slots reports
`FICT-PREVIEW-ASYNC`; use eager Core output. The
[SSR and hydration guide](./async-ssr-hydration.md) describes request ownership,
stream handoff, explicit initial data and public `hydrate`.

## Compiler and package contract

Generated output calls `createAsyncMemo` or the context-slot helper
`__fictUseAsyncMemo` from the internal ABI. Explicit async nodes are retained;
ordinary derived aliases can still use synchronous memos whose reads propagate
async readiness. Direct immutable aliases of a manual accessor allocate no
replacement memo. A reactive conditional selection can materialize a getter
returning the selected accessor; its metadata describes that extra value layer.

Metadata distinguishes these source surfaces:

| Kind            | Source surface                       | Consumer behavior                                                        |
| --------------- | ------------------------------------ | ------------------------------------------------------------------------ |
| `async`         | Resolved value, including a function | Insert a getter read; preserve an authored call of the resolved function |
| `asyncAccessor` | Manual `AsyncMemo<T>` object         | Preserve calls and methods; establish reactive consumers                 |

These kinds work in direct exports, re-exports, hook return values and structured
hook returns. `export { value as alias }` preserves a declaration's accessor.
An ordinary module-level `const snapshot = value` evaluates immediately and is
not advertised as an async accessor; module-level ordinary declarations do not
implicitly become derived computations.

The metadata envelope remains version 1 with a closed set of recognized kinds.
Older readers reject the new kinds, so publishers must use a compatible compiler
and metadata host. Do not relabel an async export as `memo` to accommodate an old
consumer: function-call and accessor-method behavior differ. The Vite library
packaging smoke test builds, packs, installs and compiles both kinds through the
published package declaration.

`FICT-ASYNC-PRODUCER`, `FICT-ASYNC-ARGUMENTS`, `FICT-PLACEMENT-ASYNC-*` and
`FICT-ASYNC-READONLY` explain unsupported declarations and writes. Existing
nested-mutation, snapshot and closure escape diagnostics continue to apply.

## Qualification

`scripts/native-compiler-async.test.mjs` executes strict native output with
optimization disabled, safe and full, through template and VNode paths. It covers
input updates, stale generations, cancellation, DOM retention/disposal, function
values, immutable aliases, ESM/CJS, cross-module metadata, strict boundaries and
source maps. Runtime ABI and TypeScript tests cover helper availability and
resolved result types. These checks do not replace the separate SSR or benchmark
gates in the implementation plan.
