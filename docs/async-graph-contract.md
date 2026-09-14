# Async graph contract

This contract defines the implemented explicit async computation model: owned
nodes, synchronous derived consumers, render preparation, Resource readiness,
causal transitions, compiler declarations and eager SSR/hydration. The
[reactivity checklist](./reactivity-implementation-plan.md) records the evidence
and qualification status for each part. The
[migration guide](./async-migration-guide.md) and
[async data example](../examples/async-data) show the supported application model.
Native continuations, async component functions and Preview ownership
serialization retain the explicit boundaries below.

## Compatibility and entry points

`createMemo(() => promise)` continues to return that Promise as an ordinary value.
Resolution does not itself invalidate a synchronous memo, and JavaScript `await`
does not implicitly preserve reactive tracking or component ownership.

The opt-in runtime entry point is `createAsyncMemo(produce)` from `fict/advanced`
or `@fictjs/runtime/advanced`. Its accessor reads a
current value, with `state()` for an immutable readiness snapshot and `latest()`
for explicit stale-value reads. `refresh()` invalidates the current generation;
`dispose()` permanently ends its ownership.

The producer receives a context containing an `AbortSignal` and the prior
successful value with a separate `hasValue` flag. It can return a synchronous
value, a Promise-like value, or an async iterable. Synchronous source reads form
the input dependencies. The node starts lazily on its first read. Once activated,
it schedules dependency checks on input invalidation even if only an imperative
token waiter remains. Equal inputs do not restart the producer. Read inputs before returning the Promise or iterator;
reads after a native `await` or inside an iterator continuation are not tracked.
Compiler-supported continuations must lower to this same explicit input/lifetime
contract. Ordinary async components retain their existing synchronous-render ABI
diagnostic until a separate render ABI supports them.

## Readiness state

`AsyncState` in `packages/runtime/src/async-state.ts` implements the state
transitions without allocating separate data, loading, error, or version signals.
A graph computation owns one state instance and publishes its immutable snapshots
through graph subscriptions. Resource cache entries use the same protocol.
`hasValue` distinguishes a successful `undefined` from no successful value;
`status: 'errored'` distinguishes rejection with `undefined` from no error.

| State         | Current read                       | `latest()`                                           | Next legal events                                              |
| ------------- | ---------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------- |
| Uninitialized | Node starts its first evaluation   | Same                                                 | Begin, dispose                                                 |
| Pending       | Throw the current readiness token  | Same                                                 | Publish, reject, supersede, dispose                            |
| Refreshing    | Throw the current readiness token  | Return prior success                                 | Publish, reject, supersede, dispose                            |
| Ready         | Return the current value           | Same                                                 | Next stream yield, stream failure/completion, refresh, dispose |
| Errored       | Throw the original rejection value | Return prior success if one exists; otherwise throw  | Refresh, dispose                                               |
| Disposed      | Throw `AsyncDisposedError`         | Inspect retained success if present; otherwise throw | No restart                                                     |

Every evaluation gets a monotonically increasing generation. Publications,
failures, and iterator completion are accepted only for the active generation.
Replacing an evaluation wakes its old waiters. A late completion cannot replace
the new value, alter its error, finish a newer transition, or restore subscriptions.
The node checks input invalidation before accepting a completion, including the
race where a source write happens before the scheduled graph flush.

The `pending` field of a pending/refreshing snapshot contains the readiness token;
it is `undefined` in other states. Retained snapshots preserve their own token or
value, including when read by cleanup before a new effect commit.

Readiness tokens are branded, stable per generation, and resolve as wakeups. They
do not reject: consumers retry and obtain the current state or original failure.
Replacement and disposal also resolve the old wakeup. This avoids unhandled token
rejections and lets a suspended consumer follow replacement work. Token handling
must not reinterpret ordinary Promise values as pending computations.

## Iteration and cancellation

The first iterator yield establishes readiness. Later yields update the current
value without returning the subtree to initial pending; an input change starts a
new generation and may expose the previous value only through `latest()`.
Readiness-related transition work finishes at the first yield, rather than waiting
forever for a long-lived stream to close. Iterator completion preserves its last
yield. An iterator that completes without yielding rejects with `AsyncEmptyError`,
including a refreshed iterator for which only an older generation has a value.
An iterator's return value is not a yield.

Superseding or disposing aborts the prior transport and calls an active iterator's
`return()` once where available. Neither operation waits for an uncooperative
transport to finish. Rejections from stale requests and iterator teardown are
consumed without changing current graph state. Graph disposal always detaches
subscriptions, even if cancellation fails. The generation check remains required
when the transport ignores abort.

## Derived values and effects

A synchronous derived value that reads unavailable async data becomes unavailable
without losing the dependencies needed to retry. Chains and diamonds retry from
current inputs. A refresh failure remains observable until explicit invalidation
or a relevant input change. `latest()` deliberately permits mixed-age data; it is
an application policy, never an implicit fallback for a current-value read.

Reactive dependency checking must finish before a previously committed effect is
cleaned up or replaced. For new or conditional dependency discovery, the explicit
`createAsyncEffect(prepare, commit)` API evaluates a pure preparation first. Only
a successful current preparation runs cleanup and then commits the new value.
Pending preparations preserve the prior committed effect; disposal cleans it up
once. Failures route to the owning error boundary and remain retryable.

The contract does not claim to roll back arbitrary side effects performed before a
throwing read in an ordinary `createEffect` callback. Application effects needing
atomic preparation use the two-phase API. Compiler-created DOM bindings must
evaluate their data before writes, and any binding fusion must preserve that
property. A Suspense boundary may display fallback; stale display requires an
explicit stale read or a defined transition policy. Independent boundaries do not
hold unrelated ready work.

For graph pending tokens, Suspense keeps the computation owner and parks the
rendered DOM while showing a separately owned fallback. It reveals the retained
DOM after graph consumers have processed publication; it does not re-execute
component setup to recreate a pending producer. Mount callbacks wait for the
first reveal. Reset and unmount dispose both the retained view and fallback.
Legacy, unbranded Suspense tokens retain their existing replay behavior.

A pending current-value read in ordinary synchronous component setup has no
reactive continuation. It produces an explicit error instead of a cancellation
and replay loop. Read the value in a reactive binding or in the preparation of
`createAsyncEffect`; `state()` and an available `latest()` are nonblocking reads.
For example, manual runtime code can create `data = createAsyncMemo(fetch)` in a
component and use `reactive(() => data())` as its child binding. This does not
introduce an async component return ABI or track reads after native `await`.

Rejection values preserve identity through derived/effect consumers and error
boundaries, even when the rejected value itself is a Promise or a readiness token.
Such values must not accidentally be interpreted as new suspension requests.

## Ownership, transitions, and data policy

An async node belongs to the captured root or an explicit disposer. Its producer
executes in that owner while collecting synchronous inputs. Transport callbacks
may publish state but cannot revive a destroyed root or silently acquire a new
reactive owner. Disposal is idempotent and releases pending waiters.

Transitions track work registered by graph updates, including a Resource request
started indirectly by a changed input. Ownership and causal registration, rather
than one global pending counter, isolate overlapping transitions and unrelated
roots. Replaced flights stop contributing to their old readiness count without
settling a newer flight. A returned transition Promise remains supported.

`useTransition` opens a causal scope for its synchronous callback. Signal writes
carry scope identities through queued effects and activated async computations,
including effect-to-signal writes and downstream async publication. Replacing a
queued write to the same signal supersedes that cause; concurrent writes to
different inputs retain both causes. Equality-suppressed computations and disposed
queued consumers release their accounting without inventing new async work.

Readiness waits for both the callback's returned Promise and causally registered
pending generations. A stream is initially ready at its first yield; later yields
do not keep an already-completed transition open indefinitely. Resource readers
use reference-counted readiness leases on shared generations. Switching keys or
disposing a reader releases its lease without cancelling transport needed by the
cache or another reader. Destroying the hook's owner ends its scopes; a retained
start function becomes inert after that disposal.

This context follows registered graph work, not native JavaScript continuation
storage. Arbitrary work after `await`, in detached timers, or in unrelated Promise
callbacks does not inherit a transition merely by lexical placement. Return a
Promise covering that work, or start an explicit transition for its later updates.
`startTransition` continues to provide scheduling priority without a pending hook.

Resource retains cache keys, TTL, SWR, LRU, deduplication, prefetch, optimistic
mutation, and request/shared-cache choices. Those are data policies. Current
readiness and generation acceptance use the shared async protocol. Existing
Resource access patterns and documented Suspense/error behavior must keep their
regression coverage during migration.

Each Resource cache entry owns an async **source** node. Unlike an async derived
node, the source has no producer input subscriptions: the cache policy decides
when to start, share, abort, or replace transport. Both node kinds use `AsyncState`
and the same computed-node publication and pending/error propagation protocol.
Resource no longer stores independent data, loading, and error signals. Pure,
lazy, shared field projections preserve equality suppression for consumers that
only read one field; the remaining version signal is a cache invalidation input.

With `suspense: true`, reactive data reads propagate initial pending and errors
through memo/effect/render consumers. A successful previous value remains readable
while refreshing, as before. Legacy synchronous setup reads retain their replay
adapter. Without Suspense, callers continue to inspect `data`, `loading`, and
`error` explicitly. Evicting a settled entry removes its cache lookup while
existing readers retain its snapshot; active shared requests outlive individual
readers. Invalidation and non-cache transport cleanup explicitly cancel their
generation. No request token or generation is exposed as public Resource API.

## Server and compiler obligations

Server rendering preserves the request owner across registered completions.
Streaming waits on the same readiness protocol, reports current errors, and
abandons disposed boundaries. Pending tokens and transports are never serialized.
Only resolved serializable data enters a request's hydration payload; hydration
must agree on source identity and initial state without sharing private request
data. Aborted requests cannot publish into another session.

Compiler lowering, metadata, runtime ABI, and types agree on the explicit
async value/accessor shapes through [`$async` declarations](./async-declarations.md). A Promise return type alone is not permission to unwrap or
move code across `await`. Strict diagnostics continue to reject unsupported
continuations and unknown hosts. Optimizer profiles must preserve invocation
counts, exceptions, reference semantics, generation ownership, and cleanup order.

## Executable acceptance

`packages/runtime/test/async-state.test.ts` executes initial pending, successful
`undefined`, rejection with `undefined`, stale reads, retry, all six settlement
orders for three generations, duplicate completions, multi-yield streams, empty
streams, failure after a yield, disposal, snapshot immutability, and ordinary
Promise-valued memo compatibility.

`async-memo.test.ts` covers node input invalidation, source-write/completion races,
transport cancellation, generations, streams, and disposal. `async-composition.test.ts`
and `async-suspense.test.ts` cover chains, diamonds, conditional subscriptions,
consumer-owned waits, independent boundaries, prepare/commit cleanup, exact error
identity, retained DOM, nested mounts, resets, and fallback-cleanup reentrancy.

`async-source.test.ts` and `packages/fict/test/resource-graph.test.ts` cover source
identity, cache ownership, generation resets, graph composition, field equality,
errors, eviction, invalidation, and cleanup reads. Existing Resource tests retain
cache, cancellation, TTL/SWR, mutation, and request-isolation coverage.

`async-transition.test.ts`, the scheduler regressions, and
`packages/fict/test/resource-transition.test.ts` exercise indirect requests,
overlap, queued replacement, stale generations, shared leases, disposal, first
stream readiness, and returned-Promise composition.

`scripts/native-compiler-async.test.mjs` executes the explicit compiler declaration,
generation ownership, callable values, import identities, metadata consumers,
source maps and strict continuation boundaries across all optimizer/DOM profiles.
Real SSR/streaming/hydration behavior is exercised by the native SSR and browser
gates listed in the [SSR guide](./async-ssr-hydration.md). The
[application evidence](./testing/async-application-evidence-2026-09-14.json)
records the fresh strict builds, async-data browser flow and real-app/streaming
checks that complete A7–A8 qualification.
