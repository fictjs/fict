---
type: architecture
title: OXC Compiler Feasibility Matrix
description: Executable M0 findings for TypeScript namespaces, CTS, decorators, comments, source maps, and CommonJS syntax in the Rust compiler.
owner: unadlib
status: accepted
risk_level: critical
tags: [compiler, rust, oxc, typescript, feasibility]
---

# OXC Compiler Feasibility Matrix

## Purpose

This document records the M0 evidence for syntax and output areas that could
invalidate the [Rust compiler architecture](rust-compiler.md). It classifies
each behavior by implementation owner and links the conclusion to executable
Rust probes. The language requirements remain owned by the existing compiler
tests and specifications; this matrix does not weaken unsupported or
strict-guarantee behavior.

## Baseline

The compiler workspace pins OXC `0.139.0`. Although that release declares Rust
`1.94.0`, its TypeScript transformer uses `if let` guards that do not compile on
the 1.94 stable compiler. The verified workspace toolchain is therefore Rust
`1.97.0`. `rust-toolchain.toml`, `Cargo.toml`, and `Cargo.lock` are the sources
of truth for these versions.

OXC JSX lowering is disabled in all Fict probes. OXC may parse JSX/TSX, but Fict
is the only owner of JSX-to-fine-grained-DOM semantics.

## Findings

| Area                                     | Observed OXC behavior                                                                                       | Target owner                    | Disposition                                                                |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------- |
| JS/TS/JSX/TSX parse                      | Parses TSX and returns owned diagnostics after the arena is released                                        | OXC adapter                     | Proceed                                                                    |
| Ordinary TypeScript stripping            | Removes type annotations while preserving runtime syntax                                                    | OXC transformer                 | Proceed with differential tests                                            |
| Namespace with exported `const`/function | Emits namespace object, assignments, and function export                                                    | OXC transformer                 | Proceed for proven subset                                                  |
| Namespace exported `let`/`var`           | Emits a warning and does not provide Fict's required mutable property synchronization                       | `fict_ts_compat`                | Mandatory compatibility pass                                               |
| Merged namespace cross-segment reference | Leaves a later unqualified reference unresolved instead of qualifying the earlier exported member           | `fict_ts_compat`                | Mandatory compatibility pass                                               |
| Nested namespace and metadata paths      | OXC can lower syntax, but does not own Fict reactive metadata identity                                      | `fict_ts_compat` + metadata     | Mandatory Fict plan/verifier                                               |
| CTS `import = require`                   | Emits a CommonJS `require` binding when CommonJS output is explicit                                         | OXC transformer                 | Proceed                                                                    |
| CTS `export =`                           | Emits `module.exports` and a strict directive                                                               | OXC transformer                 | Proceed                                                                    |
| CJS top-level `return`                   | Accepted for CommonJS source type                                                                           | OXC parser                      | Proceed                                                                    |
| Standard decorators                      | Parsed, type annotations stripped, and decorator syntax preserved                                           | OXC adapter                     | Preserve until target lowering is explicitly requested                     |
| Legacy parameter decorators              | Lowered when legacy decorator mode is explicit                                                              | OXC transformer                 | Proceed with parity fixtures                                               |
| Fict/JSDoc/pure comments                 | Statement JSDoc and optimizer annotation comments survive parse/transform/codegen                           | OXC adapter                     | Extract Fict annotations before destructive passes and retain origin tests |
| Relative TS extension rewrite            | Rewrites `.ts`/`.mts` to `.js`/`.mjs` without rewriting package names                                       | OXC transformer                 | Proceed with query/fragment host tests                                     |
| Source maps                              | Emits tokens for transformed TypeScript                                                                     | OXC codegen                     | Proceed                                                                    |
| Generated getter origin                  | A generated arrow getter whose body retains the source expression span maps back to the original expression | Fict origin model + OXC codegen | Proceed; every generated semantic node needs an explicit origin            |

## Namespace compatibility requirement

Namespace support is not an optional fallback. Before standard TypeScript
lowering, `fict_ts_compat` MUST build a plan containing all same-symbol
declaration segments, exported and internal binding identities, cross-segment
references, mutable export synchronization, nested metadata paths, source
order, and origins.

The plan MUST reject any reference or write without an owner. It MUST NOT rely
on output-text repair after OXC lowering because semantic IDs and source origins
would already be lost. General OXC fixes may be contributed upstream, but the
local compatibility verifier remains until the pinned release passes all Fict
namespace fixtures without it.

## Comments and source-map boundaries

Fict directives, suppressions, pure annotations, and `@fictReturn` comments
MUST be collected into owned compiler facts before AST passes can detach or
remove their associated nodes. Codegen comment preservation is a compatibility
aid, not the semantic source of truth.

Generated nodes MUST distinguish semantic origin from generated bookkeeping.
User expressions placed inside getters, setters, bindings, memos, or handlers
retain the original expression span. Helper imports and compiler-only
temporaries may be unmapped. Source-map verification queries generated
positions and asserts their original line and column; parsing the map JSON is
insufficient.

## Conclusion

No tested area requires retaining Babel in the target compiler. OXC provides a
viable parser, controlled TypeScript transformer, and source-map code generator
for the migration. The namespace gaps are material but have a bounded Rust
compatibility design and therefore do not trigger the M0 feasibility veto.

This conclusion applies only to the executable probes and current compiler
contracts. It does not prove full language parity; the legacy/Rust
differential suite remains the switch gate.

## Human review requirements

Reviewers MUST re-examine this matrix when:

- OXC or Rust is upgraded;
- namespace planning or mutable export synchronization changes;
- decorator mode or TypeScript module output changes;
- a comment becomes semantic input;
- source-map origin propagation changes;
- a probe is removed, skipped, or relaxed.

## Verification

Run the focused feasibility matrix:

```bash
cargo test -p fict-compiler-oxc --test feasibility
```

Run the complete native baseline:

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace
```

The executable source for every row is
`crates/fict-compiler-oxc/tests/feasibility.rs`. Existing TypeScript
namespace/CTS/compiler suites remain the final behavior authority until they
run through the backend-neutral differential harness.

# Citations

- [OXC TypeScript transformer](https://oxc.rs/docs/guide/usage/transformer/typescript.html)
- [OXC Transformer pipeline](https://oxc.rs/docs/guide/usage/transformer)
- [OXC Parser](https://oxc.rs/docs/guide/usage/parser.html)
