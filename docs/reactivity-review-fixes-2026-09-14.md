# Review fixes and local qualification: 2026-09-14

The review findings are resolved at `b8598af2`. Each independent change has its
own commit. The [machine-readable record](./testing/reactivity-review-fixes-2026-09-14.json)
contains the exact source inputs, commands, exit statuses, package/application
identities and [portable logs](./testing/reactivity-review-fixes-logs-2026-09-14.tar.gz).
This record supplements the [earlier qualification](./reactivity-qualification-2026-09-14.md);
its old measurements and full Rust workspace run remain historical evidence.

| Commit     | Change                              |
| ---------- | ----------------------------------- |
| `70ca665d` | Shared call-prop evaluation         |
| `d9840d62` | Current async consumer control flow |
| `197c7f86` | Receiver annotation contract        |
| `4fc2cacc` | No-cache Resource ownership         |
| `6b8ba62f` | Frozen corpus provenance            |
| `b8598af2` | Initial prop rejection identity     |

## Correctness and necessity

Call-valued component props now initialize once and share their result across
consumers until tracked dependencies change. This preserves object/function
identity, unread call evaluation, property order and ordinary initialization
errors. Both DOM backends and all optimizer profiles have behavioral regression tests.
An initial pending graph read remains stored for the eventual consumer. A graph
rejection still throws, even when its value is a Promise or a branded pending
token; its classification survives untracked initialization in setup and effects.

Ordinary effects execute their current callback and local `try/catch`, with
cleanup before each attempt. Runtime dependency checking neither replays obsolete
async reads nor assigns errors to memo bodies that have not executed. Failed
reads retain subscriptions, including recovery to the previous successful value.
A 1,500-node chain verifies iterative propagation. `createAsyncEffect(prepare,
commit)` retains committed work while preparation is pending. Keyed lists read
the current source before diffing and can abandon a never-settling branch while
preserving row ownership and source cleanup.

The receiver contract now agrees with direct binding and parameter annotations.
Eight normative snippets execute under six optimizer/DOM profiles; assertions,
aliases, shadowed built-ins and unannotated `$state(seed)` transfers retain their
strict boundaries. No new runtime family validation is implied by TypeScript.

No-cache Resource requests have leases held by readers, prefetches and legacy
Suspense replay. The last release cancels transport and removes the old lookup
before invoking abort callbacks. Shared readers remain independent, reset and
unmount cancel abandoned work, sequential pending setup reads can finish, and
reentrant abort callbacks can start a new request for the same key. The current
10-case ownership suite produces nine failures on the pre-fix source and passes
after the fix. Memory-cache ownership remains separate from reader lifetime.

The final native gate also found a stale current-corpus digest in the DOM oracle.
Only that reference changed; all frozen Babel inputs, outputs, traces, compiler
identity and acceptance policies remain unchanged. The existing compatibility
contract now runs before frozen replay in `pnpm test:compiler:frozen-corpus`.

## Current verification

All 22 final gates below pass on `b8598af2`. Each fix also completed
`pnpm commit`, including its build, frozen-corpus, distributed size, regression,
workspace tests, typechecks, formatting and lint lifecycle. The archive retains
those logs and the corrected provenance failure.

| Gate                | Result |
| ------------------- | ------ |
| native              | PASS   |
| rust-fmt            | PASS   |
| rust-clippy         | PASS   |
| rust-emission       | PASS   |
| vite                | PASS   |
| webpack             | PASS   |
| playground          | PASS   |
| vscode              | PASS   |
| native-packages     | PASS   |
| tarballs            | PASS   |
| runtime-package     | PASS   |
| runtime-bundler     | PASS   |
| ssr-matrix          | PASS   |
| e2e                 | PASS   |
| bundlers-strict     | PASS   |
| native-types        | PASS   |
| runtime-abi         | PASS   |
| compiler-complexity | PASS   |
| rust-crates         | PASS   |
| runtime-stress      | PASS   |
| strict-applications | PASS   |
| benchmark-build     | PASS   |

The record hashes 404 production source/configuration inputs and
verifies they remain unchanged during qualification. Strict application builds
capture actual compiler requests, diagnostics and artifact identities. Browser
and distributed ESM/CJS checks exercise the runtime and Resource package boundary.

The Rust checks rerun all-target/all-feature Clippy, formatting, source-map,
JSX text and reactive-write integration tests, frozen replay, and crate guardrails.
The earlier 893-case full Rust workspace run is preserved with its original source
identity; it is not presented as a fresh full-workspace execution.

## Current performance

The [new five-framework archive](./benchmarks/runtime-review-fixed-2026-09-14.json)
and [runtime report](./runtime-benchmark.md) measure this exact compiler/runtime
revision after correctness fixes. Two complete rounds retain all 1,450 CPU
samples; a separate memory run retains 45 whole-page samples. All five frozen
implementations pass the official keyed checks, and Fict passes the maintained
model/identity checks. The README checker recomputes every published score and the creation-cost figures.

Fict's pooled score is **1.113341327503323**. The unrounded **≤1.10** result is
**FAIL** pooled and
**FAIL / FAIL** across the two individual rounds.
No build, test, profile or competing task measurement overlaps the timed batches.
These samples do not establish a confidence interval, isolate causal async cost,
or prove global graph optimality. Selectors and per-row signals remain explicit
fixture choices.

This is local qualification. No push, remote CI result, registry publication,
other-platform execution or independent application adoption is inferred. Native
`await` continuations, async component return ABI, Preview async ownership and
general graph fusion retain their documented boundaries.
