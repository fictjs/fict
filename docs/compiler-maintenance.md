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
and fails when a file or total effective-source budget is exceeded. Effective
source lines exclude blank lines and pure comment lines, so formatting-only
changes cannot move the guardrail.

Budget values live in `scripts/compiler-complexity-report.mjs`; do not copy
them into docs. Treat the script as the source of truth for large-file budgets,
the default per-file budget, and the total compiler source budget.

These budgets are not goals. They are ceilings that keep already-large files
from growing silently while the compiler is split into smaller units.

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

For release candidates, `pnpm release:verify` runs the complexity report as part
of the top-level gate. `pnpm release:compiler:verify` also runs compiler lint,
typecheck, tests, HIR guardrails, optimizer guardrails, and the complexity
report for compiler-focused changes.
