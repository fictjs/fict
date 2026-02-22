# Strict Guarantee Test Policy

This page defines when test code should explicitly set `strictGuarantee: false`.

## Default Rule

- Keep `strictGuarantee: true` (default) for normal application compilation and guarantee-contract tests.
- Only opt out in tests that intentionally use fallback/non-guaranteed shapes to verify runtime behavior.

## Current Approved Opt-out Suites

| Suite                            | Location                                                                                                                                                                                                                                                                   | Why opt-out is required                                                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| SSR resumable fixture compiler   | `packages/ssr/test/e2e-resumable.test.ts`                                                                                                                                                                                                                                  | Fixtures intentionally include fallback-like shapes and validate resumable behavior, not strict guarantee diagnostics.            |
| SSR integration fixture compiler | `packages/ssr/test/ssr-integration.test.ts`                                                                                                                                                                                                                                | End-to-end SSR/rehydration fixtures; strict diagnostics are not the assertion target.                                             |
| Testing library Vitest pipeline  | `packages/testing-library/vitest.config.ts`                                                                                                                                                                                                                                | `.compiled.test.tsx` files validate testing helpers against compiled output patterns, including fallback-like cases.              |
| Router Vitest pipeline           | `packages/router/vitest.config.ts`                                                                                                                                                                                                                                         | Router behavior tests (navigation/history/link semantics) are not strict guarantee conformance tests.                             |
| Fict browser E2E fixture         | `packages/fict/e2e/vite.config.ts`                                                                                                                                                                                                                                         | The E2E fixture app intentionally includes fallback-like event/control-flow patterns to validate runtime behavior in browsers.    |
| Compiler behavior/option suites  | `packages/compiler/test/default-options.test.ts`, `packages/compiler/test/module-metadata-safety.test.ts`, `packages/compiler/test/reactivity-guarantee-contract.test.ts`, `packages/compiler/test/sourcemap.test.ts`, `packages/compiler/test/warnings-as-errors.test.ts` | These suites intentionally verify non-strict paths, option precedence, and warning-level behavior, so scoped opt-out is required. |

## Required Practices

1. Add an inline comment near each `strictGuarantee: false` explaining why the suite is behavior-first.
2. Keep strict coverage elsewhere:
   - compiler contract tests
   - diagnostics tests
   - normal app/library compile paths
3. Do not use opt-out as a blanket fix for real guarantee regressions.

## When Adding a New Opt-out

Use all checks below before adding `strictGuarantee: false`:

1. The test goal is runtime behavior or integration flow, not guarantee diagnostics.
2. The fixture intentionally includes unsupported/fallback patterns.
3. A strict-mode test already exists (or is added) to cover the same feature's guarantee behavior.
4. The opt-out is scoped to the narrowest test entrypoint (avoid global defaults).

## Related Docs

- `docs/reactivity-guarantee-matrix.md`
- `docs/diagnostic-codes.md`
- `docs/config-profiles.md`
