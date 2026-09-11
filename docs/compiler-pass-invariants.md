# Compiler Pass Invariants

This is the maintenance contract between the Rust compiler passes. User-facing
language behavior remains in the compiler spec and guarantee matrix.

## Pipeline contract

The pipeline is directional: OXC syntax/semantic data is adapted into Fict-owned
IR, verified between analysis stages, and converted back to an OXC output AST
only after all fail-closed checks pass. Later passes must not depend on hidden
state from an earlier implementation detail.

No OXC arena reference may escape a request. Filesystem resolution, package
metadata, caches, and bundler objects remain in the JavaScript host.

## Pass responsibilities

### Parse and OXC adapter

- Input: source, filename/language/module kind, and serializable options.
- Output: OXC syntax/semantic facts plus Fict-owned HIR with stable source
  origins.
- Macro placement policy lives outside the HIR builder driver so new macro and
  runtime-primitive rules cannot silently expand the parser-to-HIR coordinator.
- Preserve directives, comments, statement order, lexical ownership, JSX
  shape, TypeScript/CTS semantics, and macro identity.
- Rebuild semantic information after syntax-changing TypeScript passes.
- Frontend classification, TypeScript compatibility checks, and HIR construction
  may share one parsed program and semantic graph while the syntax is unchanged.
  Reuse stays inside the request arena and preserves diagnostic/policy ordering.
- Parse or adaptation failure returns structured diagnostics and no partial
  output.

### CFG and SSA

- Every Phi source corresponds to a real predecessor.
- Declaration identity respects lexical shadowing across branches, loops,
  closures, classes, and namespace segments.
- Block/node limits and fixed-point iteration budgets fail closed.
- Visible iteration and generated identities are deterministic across process,
  thread count, and platform.

### Reactivity, scope, and region analysis

- Reads, writes, escapes, hook shapes, effects, control flow, and runtime-helper
  intent are explicit IR facts.
- Branch-local declarations remain local unless a verified merge writes an
  outer binding.
- Unsupported guarantee shapes emit stable `FICT-*` diagnostics; they are not
  silently frozen or downgraded in production.
- Cross-module facts come only from the request metadata snapshot.
- Execution-state analysis preserves the greatest fixed point for observed paths
  and the least fixed points for generators and unexecuted paths, including cyclic
  aliases and alternative callable owners. Changes propagate through reverse
  dependencies; a linear alias chain must require only linear candidate checks,
  without rescanning every forwarding for each read.
- Root-only historical aliases use graph reachability. Projected aliases,
  wildcard aliases, and global-object canonicalization retain path-sensitive
  traversal, and getter-free states avoid unnecessary historical getter queries.
- Equal alias invalidation sets share immutable storage. Verifying shared members
  once must still validate every invalidation location and report every invalid
  set occurrence. Region indexes preserve full-scan input/output sets and the
  deepest dominating lexical parent, with the largest region ID breaking ties.
  Region lookups also retain support for unique unsorted binding facts accepted
  by the existing verifier.
- Parent compression caches only terminating paths within one immutable parent
  snapshot. Cyclic paths retain the bounded resolver and fixed-point limits.

### Optimizer

- Constant propagation, CSE, inlining, DCE, and Phi elimination require proven
  purity/ownership and preserve evaluation count and order.
- `safe` mode avoids authored algebraic rewrites. Opt-in `full` mode is limited
  to binding-identified local constants and documented proven identities;
  rewrites that discard an expression must prove it side-effect free and preserve
  JavaScript coercion, result types, exceptions, and evaluation count.
- A pass that does not converge within its budget is an internal compiler error,
  not best-effort output.
- Empty rewrite plans retain the existing HIR and its analyses. Any applied
  rewrite invalidates dependent analyses; final cross-function facts are rebuilt
  only after all functions have finished optimization.

### EmitIR and code generation

- Emit operation support checks and reactive mutation materialization live in
  dedicated adapter modules; the OXC codegen coordinator must not absorb new
  operation-specific lowering policy.
- Only verified IR reaches output construction.
- Every `EmitOperation` variant has a production construction site in the HIR
  lowerer; verifier-only or adapter-only operation variants are forbidden.
- `ApplyProps` models DOM spread only; component getter, rest, merge, and keyed
  props remain owned by `EmitPropsPlan` and `InvokeComponent`.
- Projected reactive writes, updates, and deletes rewrite only the accessor root
  so native JavaScript preserves key/RHS order, evaluation count, and results.
- Reactive assignment lowering preserves anonymous function and class name
  inference, including destructuring defaults and class static initialization.
  Short-circuit RHS expressions retain their authored `await`/`yield` scope.
- Runtime hooks appear only in render-safe locations and helper imports match
  the runtime ABI.
- Metadata, diagnostics, artifacts, and source maps refer to authored source
  origins.
- Multi-source map composition traces only the intermediate source uniquely
  identified by the input map `file`; other source identities are preserved,
  and missing or ambiguous identity fails closed.
- Preview handler modules are structured artifacts; integrations do not reparse
  main output to discover them.
- Duplicate list data and unsupported mutations must not be silently dropped.

### Host cache and metadata

- Cache keys include compiler build ID, protocol/cache schema, source/options,
  graph metadata fingerprint, TypeScript configuration, and integration
  artifact fingerprint.
- Unknown or malformed cache records fail closed; old records are ignored, not
  upgraded in place.
- Versioned package metadata is read only through declared
  `package.json#fict.metadata` / `fict.exports` boundaries.
- The compiler does not read or write source-adjacent Babel sidecars.
- Compiler durations and counters cross N-API only as non-negative JavaScript
  safe-integer `number` values; overflow saturates at `Number.MAX_SAFE_INTEGER`
  and never changes the protocol type to `bigint`.
- False misses are preferable to false hits.

## Complexity policy

TypeScript is a thin request/graph host. Its budget should shrink when old
compatibility code is removed and must not grow to reimplement compiler passes.
Rust crate and largest-file budgets are independently enforced and may not be
relaxed to absorb unrelated work. Extract helpers along crate/pass ownership
boundaries and document any intentional budget change.

The reactivity budget is reviewed at 13,286 lines with a 13,400-line ceiling for
shared alias facts, indexed regions, and independent invalidation/root-resolution
regressions. The workspace ceiling and other crate ceilings are unchanged.

## Verification

Run the smallest focused test first, then the applicable release gates:

```bash
cargo fmt --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace
pnpm -C packages/compiler typecheck
pnpm -C packages/compiler test
pnpm guardrails:compiler-complexity
pnpm guardrails:rust-crates
pnpm release:compiler:verify
```

Protocol, ABI, package, bundler, fuzz, source-map, or platform changes require
the complete clean-checkout release verification and native certification.
