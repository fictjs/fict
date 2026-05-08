# Typecheck Hardening Plan

The root `tsconfig.base.json` is strict by default:

- `strict: true`
- `noImplicitAny: true`
- `noImplicitReturns: true`
- `noUncheckedIndexedAccess: true`
- `exactOptionalPropertyTypes: true`

`scripts/check-typecheck-config.mjs` already guards against false-green package configs by checking that critical packages include their real `src` and test files. The remaining work is to remove temporary package-level strictness overrides.

## Current Overrides

| Package                     | Relaxed flags                                                                                                                                        | Target                                                                                                                        |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `packages/compiler`         | Standalone tsconfig does not yet inherit `exactOptionalPropertyTypes`, `noImplicitReturns`, or `noUncheckedIndexedAccess` from the root base config. | Either extend the root base config or copy the missing hardening flags after HIR/SSA optional-field construction is narrowed. |
| `packages/devtools`         | `exactOptionalPropertyTypes`, `noImplicitReturns`, `noUncheckedIndexedAccess`                                                                        | Remove before v1 stable once panel/core optional fields and indexed lookups are narrowed.                                     |
| `packages/mcp`              | `exactOptionalPropertyTypes`                                                                                                                         | Remove after store/tool response shapes distinguish omitted fields from explicit `undefined`.                                 |
| `packages/ssr`              | `exactOptionalPropertyTypes`, `noImplicitReturns`, `noUncheckedIndexedAccess`                                                                        | Remove after streaming option objects and DOM lookup branches are narrowed.                                                   |
| `packages/vite-plugin`      | `exactOptionalPropertyTypes`, `noImplicitReturns`, `noUncheckedIndexedAccess`                                                                        | Remove after transform/cache result unions and AST lookup paths are narrowed.                                                 |
| `packages/vscode-extension` | `exactOptionalPropertyTypes`                                                                                                                         | Remove after VS Code API option wrappers stop passing explicit `undefined`.                                                   |

## Candidate Command

Run this non-blocking report locally or in CI artifacts:

```sh
pnpm typecheck:strict-candidate
```

It reruns TypeScript for the packages above with their relaxed flags forced back to `true`. The command exits `0` by default so it can be used as a progress report. To turn it into a hard gate after the package list is green:

```sh
node scripts/typecheck-strict-candidate.mjs --fail-on-error
```

Output is truncated per package by default. Set `FICT_STRICT_CANDIDATE_MAX_LINES` when a full package error list is useful.

## Hardening Sequence

1. Fix one package at a time and remove that package from `scripts/typecheck-strict-candidate.mjs`.
2. Remove the corresponding overrides from the package `tsconfig.json`.
3. Run `pnpm guardrails:typecheck-config`, `pnpm --dir <package> typecheck`, and `pnpm typecheck:strict-candidate`.
4. When the candidate command reports all packages green, switch CI to `--fail-on-error` or delete the command and rely on the root strict config.
