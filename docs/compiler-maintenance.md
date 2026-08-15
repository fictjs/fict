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
and fails when a file or total effective-source ceiling is exceeded. Effective
source lines exclude blank lines and pure comment lines, so formatting-only
changes cannot move that guardrail. Compiler passes must not migrate back into
this host.

The Rust guardrail checks both crate dependency boundaries and raw `.rs` source
lines. It fails when the workspace crate set changes without review, any crate
or the workspace exceeds its ceiling, or a file exceeds the default ceiling
without an explicit exception. Existing oversized files are named with a
semantic owner and rationale, so splitting one below the default ceiling also
requires deleting its stale exception.

TypeScript budgets live in `.github/compiler-complexity-budget.json`; the
reporter in `scripts/compiler-complexity-report.mjs` enforces them. Like the
Rust budget, schema v2 records reviewed baselines separately from small, finite
ceilings, rejects missing ownership and rationale for file overrides, and
requires ratcheting after material reductions.

Rust budgets live in
`.github/rust-compiler-complexity-budget.json`. Budget increases require a
dedicated, justified commit. New crates must also be approved in
`scripts/check-rust-crate-boundaries.mjs`; adding a directory alone is not
enough.

Schema v2 separates each reviewed observation (`reviewedLines`) from its stable
policy ceiling (`maxLines`). The reserve policy rejects both exact snapshot
ceilings and arbitrarily large buffers: total, crate, and oversized-file
boundaries must retain a small finite reserve inside the configured percentage
cap. Reports show the reviewed baseline, ceiling, and remaining reserve instead
of presenting the current line count as the budget.

Material reductions trigger a ratchet failure. Lower the reviewed baseline and
ceiling in a dedicated governance commit rather than leaving newly created
headroom behind. Small reductions do not churn the budget file; the checked-in
ratchet thresholds define when another architectural review is required.

Reserve is maintenance capacity, not feature capacity. Routine bug fixes should
prefer removing dead code, simplifying local structure, or extracting cohesive
helpers into focused modules. If an architectural change genuinely requires a
higher ceiling, update its reviewed baseline and ceiling in a dedicated commit
and explain why the ownership boundary must grow; do not hide a budget change
inside behavior work. New files are allowed, but they still count toward the
total compiler ceiling, their crate ceiling, and the default per-file ceiling.

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
6. After a material extraction, update `reviewedLines` and lower the relevant
   stable ceiling while preserving the finite reserve required by schema v2.
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
