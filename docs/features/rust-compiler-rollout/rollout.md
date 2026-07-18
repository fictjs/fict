---
type: rollout
title: Rust Compiler Rollout
description: Completed default migration and fail-closed authorization rules for the Rust-only 0.31 release.
owner: unadlib
status: active
risk_level: critical
tags: [compiler, rust, oxc, rollout]
---

# Rust Compiler Rollout

## Release line

The compiler migration uses real releases rather than empty versions:

| Release  | Role                                                                   |
| -------- | ---------------------------------------------------------------------- |
| `0.29.0` | First published Rust-default release with whole-build legacy rollback  |
| `0.30.0` | Complete subsequent stable compatibility minor                         |
| `0.30.1` | Final published preset, `./legacy` export, and rollback implementation |
| `0.31.0` | Pre-1.0 breaking Rust-only removal release                             |

Preview resumability is not promoted by this sequence. It remains default-off
and outside the Core 1.0 compatibility promise.

## Source of truth

The machine-readable phase is
[`compiler-rollout-state.json`](../../../.github/compiler-rollout-state.json).
The 0.31 removal candidate must use schema v4 and bind exactly:

```json
{
  "phase": "legacy-removal",
  "rollbackBackend": "rust",
  "rustDefaultRelease": "0.29.0",
  "compatibilityRelease": "0.30.0",
  "finalLegacyRelease": "0.30.1",
  "legacyRemovalRelease": "0.31.0"
}
```

The same document points to the immutable M7 candidate/review/native
certification and the independent M9 evidence/review documents. Version strings
alone cannot authorize removal.

## M7 evidence is historical

The Rust-default decision remains bound to its approved two-candidate chain,
source revision, native build ID, 8-platform by 2-Node certification, semantic
comparison, performance/RSS measurements, package-size budgets, and human
review. Those artifacts are retained as historical evidence; the 0.31 tree does
not keep the differential, shadow, candidate, or rollback execution harnesses.
It does retain the frozen 0.28.0-test-derived source corpus, which runs only
through the Rust compiler and therefore does not restore a second backend. Its
Babel audit fields are regenerated with the exact 0.28.0 compiler artifact and
must match the original extraction audit, while its expected diagnostics and
code hashes are Rust-generated regression goldens. The former binds the audit
identity and the latter binds Rust determinism; neither is mislabelled as
full-runtime semantic equivalence.

The machine-readable
[compatibility evidence scope](../../../scripts/fixtures/compiler_compatibility_evidence_scope.json)
keeps those claim boundaries release-visible. It separately identifies the
frozen codegen corpus, the executable semantic oracle, and the request-contract
oracle, including whether exact Babel output and current Rust output execute in
CI.

Exact 0.28.0 behavior evidence is retained separately as frozen Babel output
with source, artifact, dependency, and input digests. CI executes that output
and current Rust output through one isolated semantic harness; the legacy
compiler itself is not installed or loaded during verification.

Filename and request-protocol evidence is retained separately from the Rust
codegen goldens. The exact 0.28.0 preset oracle covers real extension inference,
strict defaults, input-map composition, and explain output. Reviewed native-only
rows cover explicit grammar/module modes and the serializable metadata and
module-identity protocol without claiming that those 0.31 host fields existed in
Babel.

M7 approval cannot be reused as M9 approval.

## M9 legacy-removal gate

[`compiler-legacy-removal-evidence.json`](../../../.github/compiler-legacy-removal-evidence.json)
must bind the published 0.29.0, 0.30.0, and 0.30.1 release records plus:

- successful npm publication with provenance and immutable GitHub Releases;
- the complete 8-platform × Node 22.18/24 native certification;
- a real external consumer using the published Rust default;
- source-map, performance, peak-RSS, and package-size evidence with no
  unexplained regression;
- a successful whole-build rollback exercise performed while 0.30.1 still
  contained the rollback implementation;
- an executable 0.31 migration guide and proof that 0.30.1 is the final preset
  publication.

The aggregate document is content-digested. The release versions, tag commits,
workflow runs, evidence assets, npm integrities, and provenance must agree with
their committed release records.

After code removal and evidence generation, a maintainer signs the exact digest
in
[`compiler-legacy-removal-review.json`](../../../.github/compiler-legacy-removal-review.json).
Review schema v2 requires all eight areas:

1. replacement availability;
2. migration guidance;
3. candidate and rollback evidence;
4. published Rust-default release;
5. completed subsequent stable minor;
6. published final preset/legacy release;
7. updated Core scope and release controls;
8. removed legacy dependencies and implementation.

Any missing, false, unknown, or unbound review area blocks 0.31.

## Rust-only invariants

The removal gate scans source, package manifests, tests, CI, docs, scope, and
publish control. The 0.31 candidate must have:

- one `@fictjs/compiler` root exposing `transform`, `scan`, `analyze`, and
  `nativeCompilerInfo`;
- no `./legacy` export, TypeScript compiler IR, `createFictPlugin`, preset
  package, production Babel dependency, or old metadata/cache schema reader;
- no Vite backend/shadow option or environment fallback;
- a mandatory native Webpack loader with fail-closed V7 cache records;
- versioned Rust package metadata and no source-adjacent Babel sidecars;
- no dual-backend differential/shadow/rollback/candidate CI harness; the frozen
  Rust codegen regression remains release-blocking, while independent semantic
  evidence is kept as a distinct oracle;
- `SCOPE.md`, `maturity.json`, Changesets, API boundaries, and npm publish
  allowlist that describe the Rust-only Core set.

Native binding load errors, compiler errors, and incompatible protocol or cache
records fail the build. No module may retry through another compiler.

## Recovery after 0.31

There is no code-level rollback. Restore a complete, previously verified
application release pinned to the 0.30.1 compatibility unit. Do not mix 0.30.1
compiler output, metadata, or Preview artifacts with 0.31 runtime or integration
packages. See the
[compiler release rollback runbook](../../operations/runbooks/compiler-backend-rollback.md).

## Verification

```bash
pnpm test:compiler:rollout-state
pnpm test:api-boundaries
pnpm test:preview-boundaries
pnpm release:compiler:verify
pnpm release:verify:clean
```

The first command validates release ordering, evidence digests, human approval,
and removal scans. Only the complete clean-checkout release gate and successful
tag workflow authorize publication.

## Related decisions

- [OXC-native compiler architecture](../../architecture/rust-compiler.md)
- [ADR-0001 — Adopt an OXC-native Rust compiler](../../adr/0001-adopt-oxc-rust-compiler.md)
- [ADR-0002 — Native compiler support matrix](../../adr/0002-native-compiler-support-matrix.md)
- [ADR-0003 — Retire the Babel preset](../../adr/0003-retire-babel-preset.md)
