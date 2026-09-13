# Compiler host complexity review: 2026-09-14

The TypeScript package remains the native compiler request and metadata host.
This review accounts for source introduced after `af3d5fc0`; it does not add
TypeScript compiler passes or change emitted application code. The production
source reviewed here is the same source measured at `6a716534`.

| Boundary              | Previous reviewed / ceiling | Current reviewed / ceiling | Reserve             |
| --------------------- | --------------------------- | -------------------------- | ------------------- |
| Compiler source total | 1,105 / 1,128               | 1,187 / 1,210              | 23 lines, unchanged |
| `module-metadata.ts`  | 392 / 400                   | 415 / 423                  | 8 lines, unchanged  |
| `types.ts`            | 236 / 242                   | 294 / 300                  | 6 lines, unchanged  |

The same effective-source-line counter finds exactly 82 added lines:

- 23 in `module-metadata.ts`: recognize explicit async value/accessor kinds and
  validate untyped custom-host results before accepting their metadata authority.
  Invalid and throwing declarations remain fail-closed. This belongs at the
  existing metadata-host boundary shared by custom hosts and package files.
- 58 in `types.ts`: describe the async explanation kind and the native graph's
  bindings, functions, slots, operations, decisions, helper calls, owners and
  counters. These are erased TypeScript protocol declarations. The trace is
  observational; optimization and graph construction remain in Rust.
- One in `index.ts`: export the existing analyze-request environment policy so
  custom hosts can apply the same strict environment rules as the facade.

`native-loader.ts` changes only its explanatory comment and adds no effective
source lines. The other seven files are unchanged. Splitting declarations into
another file would leave the total unchanged; it would not remove compiler work.
The existing semantic owners therefore remain appropriate.

The dedicated budget adjustment keeps all reserve percentages, ratchet thresholds,
default per-file limits and unrelated overrides unchanged. Deleted code must still
ratchet the budget down; new analysis passes receive no TypeScript headroom.

Validation uses `pnpm guardrails:compiler-complexity` and the existing positive
and negative reporter tests. The final qualification also runs compiler host,
metadata, public type and native graph behavior gates. The earlier failing report
is retained as `/tmp/fict-q1-complexity.log`; the passing reviewed report is
`/tmp/fict-q1-complexity-reviewed.log`.
