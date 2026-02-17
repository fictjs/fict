---
name: fict-best-practices
description: Fict compiler and runtime engineering guide for correctness and reliability. Use when implementing or reviewing Fict compiler transforms, runtime reactivity behavior, SSR/resume flow, devtools/playground integration, or release CI gates in Fict repositories.
---

# Fict Compiler and Runtime Best Practices

Production-focused guidance for engineering tasks across Fict compiler, runtime,
SSR, devtools, and release workflows. Rules are optimized for AI agents doing
code changes and reviews under correctness and regression-risk constraints.

## Rule Categories by Priority

| Priority | Category                            | Impact   | Prefix        |
| -------- | ----------------------------------- | -------- | ------------- |
| 1        | Compiler Guarantees                 | CRITICAL | `compiler-`   |
| 2        | Reactivity Semantics                | CRITICAL | `reactivity-` |
| 3        | Runtime Safety and Performance      | HIGH     | `runtime-`    |
| 4        | SSR and Resume Stability            | HIGH     | `ssr-`        |
| 5        | Tooling and DX Boundaries           | MEDIUM   | `tooling-`    |
| 6        | Verification and Release Discipline | CRITICAL | `quality-`    |

## Quick Reference

### 1. Compiler Guarantees (CRITICAL)

- `compiler-strict-guarantee-ci` - Enforce fail-closed guarantee mode in CI
- `compiler-macro-placement-top-level` - Keep macros at top-level component or hook scope
- `compiler-fail-closed-diagnostics` - Treat fallback diagnostics as blockers

### 2. Reactivity Semantics (CRITICAL)

- `reactivity-derived-values` - Rely on compiler-derived memoization and avoid stale snapshots
- `reactivity-no-state-escape` - Prevent state lifetime escape outside owning scope
- `reactivity-props-shaping` - Keep props/reactive object shaping analyzable

### 3. Runtime Safety and Performance (HIGH)

- `runtime-shared-state-primitives` - Use `$store`/`createSignal` for shared state boundaries
- `runtime-effect-cleanup` - Always return cleanup for subscriptions and async side effects
- `runtime-no-side-effects-in-memo` - Keep memo bodies pure and move effects to `$effect`

### 4. SSR and Resume Stability (HIGH)

- `ssr-resource-keying` - Key resources and align Suspense boundaries with async ownership
- `ssr-resume-snapshot-contract` - Preserve snapshot schema and loader failure semantics

### 5. Tooling and DX Boundaries (MEDIUM)

- `tooling-devtools-dev-only` - Keep devtools instrumentation development-only
- `tooling-playground-runtime-isolation` - Isolate playground features from production runtime code paths

### 6. Verification and Release Discipline (CRITICAL)

- `quality-regression-tests-for-bugs` - Add minimal regression tests for every fixed defect
- `quality-release-gates` - Run compiler/runtime gates before merge or release

## How to Use

Read rule files in `rules/` for detailed explanations and bad/good examples.
Use `AGENTS.md` when you want a single compiled document with all rules.

## Full Compiled Document

`AGENTS.md`
