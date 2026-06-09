# Compiler Maintenance

Fict's compiler is intentionally deep: HIR, SSA, CFG structurizing, scope
analysis, shape inference, region grouping, optimizer passes, and codegen all
carry real product behavior. That depth needs explicit maintenance guardrails.

## Complexity Report

Run:

```bash
pnpm guardrails:compiler-complexity
```

The report scans `packages/compiler/src`, prints the largest TypeScript files,
and fails when a file or total source budget is exceeded.

Current large-file budgets intentionally reflect the existing codebase:

| File                                      | Budget |
| ----------------------------------------- | ------ |
| `packages/compiler/src/ir/codegen.ts`     | 10705  |
| `packages/compiler/src/ir/optimize.ts`    | 7454   |
| `packages/compiler/src/ir/regions.ts`     | 7345   |
| `packages/compiler/src/index.ts`          | 4889   |
| `packages/compiler/src/ir/build-hir.ts`   | 4176   |
| `packages/compiler/src/ir/structurize.ts` | 1953   |

All other compiler source files use the default budget of 1800 LOC.

These budgets are not goals. They are ceilings that keep already-large files
from growing silently while the compiler is split into smaller units. The
current total compiler source budget is 61337 LOC.

## Refactor Rule

When touching one of the budgeted files:

1. Prefer extracting cohesive helpers into focused modules with tests.
2. Keep generated output snapshots stable unless the behavior change is the
   purpose of the patch.
3. Run `pnpm release:compiler:verify` for behavior changes.
4. Run `pnpm guardrails:compiler-complexity` after any meaningful compiler
   refactor.
5. Lower the relevant file budget only after the extraction lands.
6. Preserve the pass ownership and invariants in
   `docs/compiler-pass-invariants.md`.

## Compile-Time Profiling

Use the existing optimizer and HIR guardrails for latency and output size:

```bash
pnpm bench:optimizer:guard
pnpm guardrails:hir
```

For release candidates, `pnpm release:compiler:verify` runs compiler lint,
typecheck, tests, HIR guardrails, optimizer guardrails, and the complexity
report.
