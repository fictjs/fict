# Async graph migration

Choose the API by the ownership and data policy the application needs:

| Existing code or requirement                                                   | Migration                                                                                                        |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `resource` with cache, refresh, TTL, SWR or shared requests                    | Keep its API. Its readiness now uses an async graph source; cache policy still owns transport.                   |
| Separate result/loading/error signals around one owned computation             | Use `$async` in compiled code, or `createAsyncMemo` from `fict/advanced` for an explicit accessor.               |
| An ordinary memo returning a Promise                                           | Keep it if the Promise itself is the value. Opt into an async node when consumers need resolved-value readiness. |
| An effect that must preserve its previous committed work while data is pending | Use `createAsyncEffect(prepare, commit)`; keep side effects out of preparation.                                  |
| A transition that changes inputs of activated async nodes                      | Keep `useTransition`; pending includes causal downstream graph work and a returned Promise.                      |
| Per-request server data and eager hydration                                    | Use the async SSR APIs and an explicit JSON-safe initial-data handoff.                                           |

Capture producer inputs synchronously, and pass them to ordinary async helpers.
The helper can await a request using `context.signal`; it must not rely on reads
after native `await` being tracked. Do not create a new async child inside a
producer that will be replayed while that child is pending. Declare dependencies
in their view/request owner, then read or compose them from the producer.

Read resolved values inside JSX bindings or a preparation callback. Reading a
pending current value during synchronous component setup cannot resume that
function midway. Use `state()` or an available `latest()` when an explicit
nonblocking/stale read is required. `latest()` is a display policy; it can combine
values from different generations and is never inserted implicitly.

Keep explicit error and loading boundaries. A Resource with Suspense preserves
its documented previous-value behavior while refreshing; a current read of an
explicit async memo suspends during refresh. Changing APIs can therefore change
the refresh UI even though both use the same readiness protocol. Test that choice
with input changes, errors, stale completions and unmounts.

Upgrade compiler, runtime and metadata publishers together. Async value exports
and manual accessor exports have different metadata kinds; old consumers reject
those new kinds. Async components and Preview serialization of async ownership
remain outside the supported ABI.

The [async data example](../examples/async-data) shows Resource policy alongside
an owned `$async` computation, an ordinary derivation, causal transition pending,
retained DOM during refresh, error recovery and view disposal. Follow the
[declaration](./async-declarations.md), [graph contract](./async-graph-contract.md)
and [SSR/hydration](./async-ssr-hydration.md) guides for the exact boundaries.
