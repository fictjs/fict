# Compiler Pass Invariants

This document records the maintenance contract between the compiler passes. It
is not a user-facing language spec. Use it when changing HIR, SSA, region
lowering, optimization, codegen, diagnostics, or cache behavior.

## Pipeline Contract

The compiler pipeline has one directional ownership rule: an earlier pass may
attach metadata for later passes, but a later pass must not depend on hidden
state from an earlier implementation detail. If a later pass needs a fact, that
fact must be represented in HIR metadata, pass options, or an explicit analysis
result.

The default production posture is fail closed. A pass that cannot preserve
reactive semantics must emit a diagnostic or throw a typed `HIRError`; it must
not silently freeze a derived value, reorder observable effects, drop DOM data,
or fall back to a stale cache artifact.

## Pass Responsibilities

### Parse And HIR Build

- Input: Babel AST.
- Output: `HIRProgram` with statement order, lexical declarations, JSX shape,
  source locations, and macro markers preserved.
- Invariants:
  - Source statement order is authoritative for observable effects.
  - Temporary names are deterministic per build and reset between independent
    `buildHIR` calls.
  - Destructuring, loops, catch bindings, and function/class scopes must produce
    explicit HIR declarations or metadata for downstream shadowing checks.
- Failure mode: throw `HIRError` with `BUILD_ERROR`.
- Required tests: HIR builder tests for new syntax lowering and any resettable
  build-scoped counters.

### SSA And CFG

- Input: structured HIR blocks.
- Output: SSA-versioned HIR with CFG predecessor/successor relationships.
- Invariants:
  - Every Phi source must correspond to a real predecessor block.
  - SSA names keep their original base names via `$$ssa` suffixes only.
  - Debug-only warnings are not enough for malformed CFG or Phi state.
- Failure mode: throw `HIRError` with `SSA_ERROR`.
- Required tests: malformed CFG/Phi tests plus behavior tests for any branch,
  loop, or exception-flow change.

### Scope And Region Analysis

- Input: HIR, normally after SSA for control-flow-aware dependency analysis.
- Output: explicit reactive scopes, dependencies, declarations, effects, and
  control-flow metadata.
- Invariants:
  - Branch-local declarations remain branch-local unless a later merge point
    explicitly writes an outer binding.
  - Reads used for reactivity are base-name normalized, but declaration
    identity still respects lexical shadowing.
  - Region grouping must preserve source-relative order around ordinary
    statements with observable effects.
- Failure mode: emit a strict diagnostic for unsupported reactive guarantees or
  throw a typed `HIRError` for internal inconsistency.
- Required tests: jsdom integration tests for observable UI/runtime behavior,
  not only HIR snapshots.

### Optimizer

- Input: HIR plus pass options.
- Output: semantically equivalent HIR.
- Invariants:
  - Optimizations are allowed only when purity, shadowing, and writes are known.
  - Constant propagation, CSE, inlining, DCE, and Phi elimination must preserve
    observable evaluation count and order.
  - Fixed-point passes must fail closed when they do not converge within their
    guard budget.
  - `strictMacroBindings` and reactive macro metadata are part of optimizer
    purity decisions.
- Failure mode: throw `HIRError` with `OPTIMIZE_ERROR` for internal optimizer
  guard failures.
- Required tests: focused optimizer tests plus integration coverage when a pass
  can affect generated DOM or effect ordering.

### Region Lowering And Codegen

- Input: analyzed HIR, region metadata, diagnostics, and compiler options.
- Output: JavaScript/TypeScript AST and runtime helper imports.
- Invariants:
  - Runtime hooks are emitted only in render-safe locations.
  - Conditional paths must not lazily create a hook slot after render execution.
  - Plain branch-local derived values may be lowered as plain expressions when
    they do not need cross-render identity.
  - If strict diagnostics reject a shape, codegen must not also rely on an
    unsupported best-effort runtime fallback for production builds.
  - Duplicate user data such as keyed list entries must not be silently dropped.
- Failure mode: emit the relevant `FICT-*` diagnostic or throw `HIRError` with
  `CODEGEN_ERROR`.
- Required tests: compiler integration tests that compile and execute generated
  code in jsdom for branch, list, event, async, and store behavior.

### Cache Fingerprint

- Input: compiler artifact paths, source-root discovery, and package version.
- Output: persistent cache key components.
- Invariants:
  - Source-mode compiler fingerprints include every `src/**/*.ts` and
    `src/**/*.tsx` artifact that can change compiler output.
  - Distribution-mode fingerprints include the published artifact content.
  - A cache key must prefer false misses over false hits.
- Failure mode: disable or miss the cache rather than reusing a stale compiler
  artifact.
- Required tests: source-mode path remapping tests that mutate nested compiler
  files such as `ir/regions.ts`, `ir/codegen.ts`, and `ir/optimize.ts`.

## Large-File Refactor Policy

The largest compiler files are allowed only as a tracked baseline. New compiler
work should not make them larger unless the change is a narrow bug fix that
would be riskier to split. When practical, extract cohesive helpers into files
named after their ownership boundary, for example `codegen-*`, `optimizer-*`,
or `region-*`.

Before extracting a helper, identify which pass owns each input fact and output
fact. If a helper needs both region analysis and codegen context, prefer an
explicit parameter object over importing unrelated pass internals.

Duplicate AST/HIR walkers are tolerated only when their semantics differ. If a
new walker is added, document whether it is collecting reads, writes, purity,
dependencies, generated names, or shadowing; do not reuse a read walker for a
write-sensitive pass without tests.

## Verification Checklist

For compiler behavior changes, run the smallest focused test first, then the
release gate relevant to the affected pass:

```bash
pnpm -C packages/compiler typecheck
pnpm -C packages/compiler test
pnpm guardrails:compiler-complexity
pnpm guardrails:hir
pnpm bench:optimizer:guard
```

Use `pnpm release:compiler:verify` before release-oriented compiler changes or
when a change crosses HIR, optimizer, region lowering, and codegen boundaries.
