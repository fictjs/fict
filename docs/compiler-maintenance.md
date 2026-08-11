# Compiler Maintenance

Fict's compiler is intentionally deep: HIR, SSA, CFG structurizing, scope
analysis, shape inference, region grouping, optimizer passes, and codegen all
carry real product behavior. That depth needs explicit maintenance guardrails.

## Complexity Reports

Run:

```bash
pnpm guardrails:compiler-complexity
pnpm guardrails:rust-crates
```

The TypeScript report scans the thin `packages/compiler/src` request/graph host
and fails when a file or total effective-source budget is exceeded. Effective
source lines exclude blank lines and pure comment lines, so formatting-only
changes cannot move that guardrail. Compiler passes must not migrate back into
this host.

The Rust guardrail checks both crate dependency boundaries and raw `.rs` source
lines. It fails when the workspace crate set changes without review, any crate
or the workspace exceeds its ceiling, or a file exceeds the default ceiling
without an explicit exception. Existing oversized files are named explicitly,
so splitting one below the default ceiling also requires deleting its stale
exception.

TypeScript budget values live in `scripts/compiler-complexity-report.mjs`; do
not copy them into docs. Treat the script as the source of truth for the thin
host's file and total budgets.

Rust budgets live in
`.github/rust-compiler-complexity-budget.json`. Budget increases require a
dedicated, justified commit. New crates must also be approved in
`scripts/check-rust-crate-boundaries.mjs`; adding a directory alone is not
enough.

These budgets are not line-count snapshots or goals. They are stable policy
ceilings with a small, finite refactor reserve. Do not synchronize them to the
current report after each change or set a ceiling to the exact observed line
count. A ceiling moves only when an architectural review changes the permitted
size of that ownership boundary.

Treat the checked-in budgets for the largest compiler files and total effective
LOC as a no-growth policy. Routine bug fixes must stay within the current
ceilings by removing dead code, simplifying local structure, or extracting
cohesive helpers into focused modules. If an architectural change genuinely
requires a higher ceiling, change the relevant source of truth in a dedicated
commit and record why the ownership boundary must grow; do not hide a budget
change inside behavior work. New files are allowed, but they still count toward
the total compiler budget and the default per-file ceiling.

## Refactor Rule

When touching one of the budgeted files:

1. Prefer extracting cohesive helpers into focused modules with tests.
2. Keep generated output snapshots stable unless the behavior change is the
   purpose of the patch.
3. Run `pnpm release:compiler:verify` for behavior changes.
4. Run `pnpm guardrails:compiler-complexity` after any meaningful compiler
   refactor.
5. Run `pnpm guardrails:rust-crates` after changing Rust compiler sources or
   crate dependencies.
6. After a material extraction, lower the relevant ceiling to the next reviewed
   stable boundary, not to the exact current line count.
7. Preserve the pass ownership and invariants in
   `docs/compiler-pass-invariants.md`.

## Compile-Time Profiling

Use the Rust/native release gates for latency, RSS, output size, and package
size evidence:

```bash
pnpm verify:rust-workspace
pnpm release:compiler:verify
```

For release candidates, `pnpm release:verify:clean` runs both complexity
reports as part of the top-level gate. `pnpm release:compiler:verify` also runs
compiler lint, typecheck, native runtime/package, bundler, ABI, and the same
complete Rust workspace verification used by CI.
