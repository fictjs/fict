# @fictjs/compiler v0.31.0 Release Notes (Draft)

Status: release candidate

## Rust-only compiler

Fict 0.31 completes the compiler ownership transition. The package root is the
OXC/Rust request facade and exposes synchronous/asynchronous transform, scan,
analysis, diagnostics, source maps, artifacts, metadata, stats, and native build
information.

## Breaking removals

- removed the in-tree TypeScript/Babel compiler and old IR;
- removed `@fictjs/compiler/legacy` and `createFictPlugin`;
- retired `@fictjs/babel-preset` after its final 0.30.1 release;
- removed Vite `legacy` / `rust` / `shadow` selection and
  `FICT_COMPILER_BACKEND`;
- made the Webpack native loader mandatory;
- removed source-adjacent Babel metadata and old cache-schema readers;
- removed differential, shadow, candidate, and code-level rollback harnesses.

Metadata returned by the compiler and published by libraries must carry the
versioned Rust schema. Package declarations use `package.json#fict.metadata` or
`package.json#fict.exports`.

## Migration

Upgrade a complete Fict dependency set from 0.30.1, remove preset/legacy/backend
configuration, clear generated output and application-owned compiler/bundler
caches, then run the native binding smoke in
[`docs/migration-guide.md`](../../../docs/migration-guide.md).

There is no code-level rollback after 0.31. Recovery means restoring a complete,
previously verified application release pinned to the 0.30.1 compatibility
unit.

## Release gates

```bash
pnpm test:compiler:rollout-state
pnpm test:api-boundaries
pnpm guardrails:compiler-complexity
pnpm guardrails:rust-crates
pnpm release:compiler:verify
pnpm release:verify:clean
```

Publication also requires the digest-bound M9 evidence/review, complete native
certification, npm provenance, and the GitHub Release workflow.

This document is separate from the Changesets-managed `CHANGELOG.md`.
