---
type: adr
title: ADR-0001 — Adopt an OXC-native Rust compiler
description: Why Fict is replacing its Babel compiler with a typed Rust compiler while keeping bundler state in JavaScript hosts.
owner: unadlib
status: accepted
risk_level: critical
tags: [compiler, rust, oxc, napi]
---

# ADR-0001 — Adopt an OXC-native Rust compiler

## Context

The current compiler owns Fict-specific HIR, CFG, SSA, reactivity, region,
optimizer, DOM lowering, diagnostics, and metadata behavior, but its frontend,
intermediate syntax fragments, generated names, and output remain coupled to
Babel AST and Babel scope. Compiler complexity is concentrated in a small set
of large, frequently changed TypeScript files, and integrations repeat Babel
parsing, graph, cache, and output work.

Fict must improve this structure without changing the language semantics in
[Compiler Spec](../compiler-spec.md), the fail-closed classifications in the
[Guarantee Matrix](../reactivity-guarantee-matrix.md), or the compiler/runtime
ABI. The compiler must also continue to work with bundlers whose resolver and
module identities cannot be reproduced correctly inside a standalone core.

## Decision

Fict will implement its default compiler as an OXC-native Rust pipeline with a
Fict-owned typed HIR and reactive IR. OXC owns syntax parsing, semantic facts,
AST construction, and final code/source-map generation. Fict owns every
language-specific analysis and lowering pass.

The Rust core is a pure compile service. It receives source, serializable
options, and a resolved metadata snapshot, and returns code, source map,
diagnostics, metadata, artifacts, and statistics. Vite, Webpack, and other
JavaScript hosts continue to own module resolution, graph convergence, disk
cache, watch state, sidecars, and package assets.

The public npm package remains `@fictjs/compiler` and loads prebuilt native
packages through N-API. The migration temporarily supports build-level legacy,
Rust, and shadow modes. Per-file fallback is prohibited. After compatibility
gates and a deprecation window, the TypeScript compiler and Babel production
dependencies are removed.

The detailed boundaries are normative in
[Fict Rust Compiler Architecture](../architecture/rust-compiler.md).

## Options considered

### Replace only the parser

Rejected. Translating OXC/ESTree into Babel while retaining the TypeScript
compiler creates a double runtime and leaves the custom hot path, string
identity, and AST coupling unchanged.

### Traverse OXC AST directly without Fict IR

Rejected. Fict's CFG, SSA, region, control-flow, and fine-grained DOM semantics
need stable pass boundaries and verifiers. Direct AST mutation would make those
facts incidental and difficult to compare during migration.

### Expose a Rust Babel-like AST as the compiler API

Rejected for the target architecture. It is useful as a compatibility bridge,
but it preserves conversion and serialization costs and makes Babel's shape a
long-term constraint. Fict instead isolates OXC translation in one adapter and
keeps its core IR implementation-independent.

### Fork OXC to insert Fict into its fixed transformer order

Rejected. A permanent fork would transfer OXC API, release, security, and
compatibility maintenance into Fict. General fixes should be contributed
upstream; Fict-specific TypeScript behavior stays in a local compatibility
pass.

### Keep the Babel compiler indefinitely

Rejected. A permanent dual implementation doubles the semantic maintenance
surface, weakens deterministic testing, and makes fallback behavior part of the
product contract.

## Consequences

Positive:

- compiler-hot-path data uses typed IDs, compact collections, and request-local
  allocation;
- parser, semantic, lowering, and code generation no longer cross a Babel AST
  boundary;
- pass inputs, invalidation, verifiers, diagnostics, and source origins become
  explicit;
- native integrations and parallel compilation can improve large-project
  throughput without changing Fict semantics;
- the npm facade can preserve normal JavaScript consumption without requiring
  users to install Rust.

Costs and constraints:

- every existing language edge case requires differential evidence before
  legacy removal;
- OXC 0.x changes must be isolated and upgraded deliberately;
- native packages add a platform build, provenance, and release matrix;
- TypeScript namespaces and CTS require a Fict compatibility layer until OXC
  provides proven equivalent behavior;
- Babel preset users require an explicit migration and deprecation window;
- bundler state remains a cross-language protocol rather than moving entirely
  into Rust.

## Risks

- A superficially matching output can hide evaluation-order, hook-slot,
  cleanup, metadata, or source-map regressions.
- Arena lifetimes can escape through caches or N-API if crate boundaries are
  violated.
- Native package gaps can make an otherwise correct compiler uninstallable.
- Shadow/legacy support can accidentally become permanent or introduce mixed
  backend builds.
- An OXC upgrade can change syntax or semantic behavior without a Fict source
  change.

These risks are controlled by per-pass differential fixtures, runtime behavior
tests, exact dependency pinning, build identifiers, whole-build backend
selection, native tarball tests, and staged removal of legacy code.

## Follow-up

Implementation follows the M0–M9 migration in the architecture plan: pin the
toolchain, establish feasibility and protocols, port frontend and typed IR,
port analyses and codegen, migrate integrations and packaging, switch through
shadow/canary gates, migrate Preview independently, and finally remove legacy
paths.

## Human review requirements

Any change that alters the dependency boundaries, permits per-file fallback,
changes strict-guarantee classification, modifies runtime/metadata ABI, or
changes the supported native platform matrix requires explicit maintainer
review and an ADR update or superseding ADR.

## Verification

- Architecture boundary: Cargo dependency checks and
  `pnpm test:api-boundaries`.
- Preview isolation: `pnpm test:preview-boundaries`.
- Semantic compatibility: dual-backend differential and runtime suites before
  the default switch, followed after legacy removal by the frozen Rust codegen
  regression plus a distinct Babel-owned semantic oracle. The Rust-generated
  golden cannot satisfy the second role.
- Native distribution: clean-install platform tarball tests before release.
- Completion: the definition and release gates in
  [Fict Rust Compiler Architecture](../architecture/rust-compiler.md) must all
  pass; acceptance of this decision alone does not prove implementation.

# Citations

- [OXC architecture and tools](https://oxc.rs/docs/guide/what-is-oxc)
- [React Compiler Rust migration](https://github.com/facebook/react/pull/36173)
- [NAPI-RS release model](https://napi.rs/docs/deep-dive/release)
