# @fictjs/compiler v1.0.0 Release Notes (Draft)

Date: February 6, 2026
Status: Release Candidate

## Scope

This release finalizes the compiler's HIR/CFG pipeline for v1.0 with a focus on correctness, diagnostics, and release quality gates.

## Highlights

- Fixed validation aggregation gaps for nested functions and callback contexts.
  - `validateFunction` now preserves ancestor chains for nested callbacks.
  - Hook conditional/loop checks are scoped to the current function boundary.
  - Nested function traversal is isolated to avoid cross-function false positives.
- Strengthened validation coverage for:
  - conditional hook checks (`FICT-C001/C002`)
  - list key diagnostics in mapped JSX (`FICT-J002`)
  - composite diagnostics aggregation (`FICT-X003`)
- Removed all `@typescript-eslint/no-explicit-any` usage in compiler source.
  - This tightened type safety across build/lower/SSA/region/optimizer paths.

## Engineering Quality Outcome

Compiler package quality gates now pass cleanly:

- `pnpm --dir packages/compiler lint`: pass (0 warnings, 0 errors)
- `pnpm --dir packages/compiler typecheck`: pass
- `pnpm --dir packages/compiler test`: pass (55 test files, 891 tests)

## Key Internal Areas Hardened

- Validation pipeline
  - `packages/compiler/src/validation.ts`
  - `packages/compiler/test/validation.test.ts`
- HIR/IR implementation and lowering
  - `packages/compiler/src/ir/build-hir.ts`
  - `packages/compiler/src/ir/regions.ts`
  - `packages/compiler/src/ir/ssa.ts`
  - `packages/compiler/src/ir/codegen.ts`
  - `packages/compiler/src/ir/optimize.ts`
- Supporting analysis/transforms
  - `packages/compiler/src/ir/scopes.ts`
  - `packages/compiler/src/ir/shapes.ts`
  - `packages/compiler/src/ir/structurize.ts`
  - `packages/compiler/src/region-grouping.ts`
  - `packages/compiler/src/transform-expression.ts`
  - `packages/compiler/src/index.ts`

## Release Gate Requirements

Before publishing this package:

1. `pnpm release:compiler:verify`
2. Confirm no new failing diagnostics in `packages/compiler/test/validation.test.ts`
3. Confirm benchmark guardrails pass:
   - `pnpm guardrails:hir`
   - `pnpm bench:optimizer:guard`

## Notes

- This document is intentionally separate from Changesets-managed `CHANGELOG.md`.
- Final version number and changelog entries should continue to be produced through the Changesets release flow.
