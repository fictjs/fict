# Runtime Error Semantics

This document is the normative contract for how the Fict runtime behaves when
user code throws inside reactive primitives. Every rule below is enforced by
`packages/runtime/test/error-recovery.test.ts` (plus the cases referenced
inline); treat that suite as the executable form of this contract.

The guiding principle mirrors the compiler's fail-closed stance: **an error
must never silently corrupt the reactive graph**. A throwing computation may
lose its own run, but it must not strand sibling work, serve stale values as
if they were fresh, or permanently detach a node from its dependencies.

## Effect errors during a flush

When an effect's body throws and no root error handler consumes the error:

- The error propagates to the caller of the write (synchronous `batch`) or
  surfaces as an unhandled microtask error (scheduled flush).
- Sibling effects queued in the same flush are **not** stranded: the scheduler
  drops the already-processed prefix, reschedules the remainder, and they
  observe the same update in a follow-up microtask.
- The flush guard always ends; subsequent writes schedule normally.
- The throwing effect itself misses that one run and re-runs on the next
  write of any of its dependencies.

With a root error handler (`registerErrorHandler`, `ErrorBoundary`), the error
is consumed and sibling effects run in the same flush.

## Cleanup errors

When a cleanup function registered via `onCleanup` (or a custom cleanup
runner) throws:

- All other cleanups in the same list still run; the first error is rethrown
  after the list is drained (or routed to the root error handler).
- The owning effect is **not** bricked: it skips the run that triggered the
  cleanup, stays subscribed with clean flags, and re-runs on the next write.
- The cleanup list is consumed even on error, so a throwing cleanup never
  re-fires on later runs.

## Memo (computed) errors

When a memo's getter throws during an update:

- The read that triggered the update rethrows the error.
- Subsequent reads rethrow the **same cached error** instead of silently
  serving the stale pre-throw value. (`throw undefined` is preserved
  faithfully; the cache is boxed.)
- The node's flags stay clean, so dependency-change propagation still works:
  the next change to any dependency marks the memo dirty, the getter retries,
  and a successful recompute clears the cached error.
- Stale-dependency semantics are unchanged: dependencies tracked before the
  throw stay subscribed, purged dependencies do not re-trigger (see
  `signal.test.ts` "removes stale dependencies when computed throws during
  update").
- A throw during the **initial** evaluation resets the memo to a clean slate;
  the next read retries from scratch.

## Effects that write their own dependencies

An effect that writes a signal it also reads is re-queued after each
successful run until it converges (the write no longer changes the value or
the effect stops writing). This includes self-writes made during the initial
run.

Convergence is **bounded by cycle protection**, not by the scheduler itself: a
self-write loop that never converges is treated like any other reactive cycle
and trips the cycle guard (configurable flush budget, dev-mode throw,
prod-mode warning with queue drop). See [cycle-protection.md](./cycle-protection.md)
for thresholds and tuning. Do not rely on a specific iteration count; if a
computation needs N convergence steps by design, derive it with a memo or an
explicit loop instead.

## What stays out of contract

- The _ordering_ of error delivery relative to DevTools hooks and dev-mode
  logging is not specified.
- Errors thrown by third-party code inside event handlers follow DOM event
  semantics plus the boundary routing described in
  [error-boundary.md](./error-boundary.md); they do not pass through the
  scheduler paths above.
- Async errors (rejected promises inside effects) are owned by
  `resource()`/`Suspense` or the user's own promise handling; the scheduler
  contracts here cover synchronous throws only.
