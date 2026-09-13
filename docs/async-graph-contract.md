# Async graph contract

This contract defines the explicit async computation model. Implementation and
qualification are tracked separately in
[the reactivity checklist](./reactivity-implementation-plan.md). The readiness
state protocol and the explicit computed node are implemented. Publishing the
contract does not certify the later composition, compiler, or SSR work.

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
through graph subscriptions. Resource cache policy can use the same protocol.
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

Resource retains cache keys, TTL, SWR, LRU, deduplication, prefetch, optimistic
mutation, and request/shared-cache choices. Those are data policies. Current
readiness and generation acceptance use the shared async protocol. Existing
Resource access patterns and documented Suspense/error behavior must keep their
regression coverage during migration.

## Server and compiler obligations

Server rendering preserves the request owner across registered completions.
Streaming waits on the same readiness protocol, reports current errors, and
abandons disposed boundaries. Pending tokens and transports are never serialized.
Only resolved serializable data enters a request's hydration payload; hydration
must agree on source identity and initial state without sharing private request
data. Aborted requests cannot publish into another session.

Compiler lowering, metadata, runtime ABI, and types must agree on the explicit
async accessor shape. A Promise return type alone is not permission to unwrap or
move code across `await`. Strict diagnostics continue to reject unsupported
continuations and unknown hosts. Optimizer profiles must preserve invocation
counts, exceptions, reference semantics, generation ownership, and cleanup order.

## Executable acceptance

`packages/runtime/test/async-state.test.ts` executes initial pending, successful
`undefined`, rejection with `undefined`, stale reads, retry, all six settlement
orders for three generations, duplicate completions, multi-yield streams, empty
streams, failure after a yield, disposal, snapshot immutability, and ordinary
Promise-valued memo compatibility.

Later graph qualification must additionally execute source-write/completion races,
chains, diamonds, changing conditional subscriptions, independent boundaries,
prepare/commit cleanup, transport cancellation, indirect and overlapping
transitions, Resource policy regressions, and real SSR/streaming/hydration cases.
Passing the state tests alone does not satisfy those integration requirements.
