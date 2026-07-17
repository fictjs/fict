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

### Optimizer

- Constant propagation, CSE, inlining, DCE, and Phi elimination require proven
  purity/ownership and preserve evaluation count and order.
- `safe` mode avoids algebraic rewrites that can alter JavaScript semantics.
- A pass that does not converge within its budget is an internal compiler error,
  not best-effort output.

### EmitIR and code generation

- Emit operation support checks and reactive mutation materialization live in
  dedicated adapter modules; the OXC codegen coordinator must not absorb new
  operation-specific lowering policy.
- Only verified IR reaches output construction.
- Every `EmitOperation` variant has a production construction site in the HIR
  lowerer; verifier-only or adapter-only operation variants are forbidden.
- Runtime hooks appear only in render-safe locations and helper imports match
  the runtime ABI.
- Metadata, diagnostics, artifacts, and source maps refer to authored source
  origins.
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
- False misses are preferable to false hits.

## Complexity policy

TypeScript is a thin request/graph host. Its budget should shrink when old
compatibility code is removed and must not grow to reimplement compiler passes.
Rust crate and largest-file budgets are independently enforced and may not be
relaxed to absorb unrelated work. Extract helpers along crate/pass ownership
boundaries and document any intentional budget change.

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
