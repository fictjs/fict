# Typecheck Hardening Status

The root `tsconfig.base.json` is strict by default:

- `strict: true`
- `noImplicitAny: true`
- `noImplicitReturns: true`
- `noUncheckedIndexedAccess: true`
- `exactOptionalPropertyTypes: true`

`scripts/check-typecheck-config.mjs` guards against false-green package configs by checking that critical packages include their real `src` and test files. The May 9, 2026 hardening pass removed the temporary package-level strictness overrides.

## Completed Overrides

| Package                     | Status                                                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `packages/compiler`         | Standalone config now explicitly enables `exactOptionalPropertyTypes`, `noImplicitReturns`, and `noUncheckedIndexedAccess`. |
| `packages/devtools`         | Package-level overrides for `exactOptionalPropertyTypes`, `noImplicitReturns`, and `noUncheckedIndexedAccess` removed.      |
| `packages/mcp`              | Package-level `exactOptionalPropertyTypes` override removed.                                                                |
| `packages/ssr`              | Package-level overrides for `exactOptionalPropertyTypes`, `noImplicitReturns`, and `noUncheckedIndexedAccess` removed.      |
| `packages/vite-plugin`      | Package-level overrides for `exactOptionalPropertyTypes`, `noImplicitReturns`, and `noUncheckedIndexedAccess` removed.      |
| `packages/vscode-extension` | Package-level `exactOptionalPropertyTypes` override removed.                                                                |

## Gate Command

Run the strict hardening gate locally or in CI:

```sh
pnpm typecheck:strict-candidate
```

It reruns TypeScript for the packages above with the hardening flags forced to `true` and exits non-zero on any regression. The same gate is wired into PR typecheck, `precommit`, and `release:verify`.

Output is truncated per package by default. Set `FICT_STRICT_CANDIDATE_MAX_LINES` when a full package error list is useful. The underlying script can still be run without `--fail-on-error` for ad hoc progress reports.

## Current RC Status

As of the v1 RC hardening pass on May 9, 2026, the strict candidate report is green for all tracked packages:

- `compiler`
- `devtools`
- `mcp`
- `ssr`
- `vite-plugin`
- `vscode-extension`

The release gate now also runs:

```sh
pnpm typecheck:tests
```

That command typechecks the currently clean high-risk test slices for runtime,
compiler, vite-plugin, and SSR. It is a regression guard for test harness
coverage; `pnpm typecheck:strict-candidate` separately guards the package source
strictness posture listed above.

## Hardening Sequence

The package hardening sequence is complete. For future packages:

1. Add the package to `scripts/typecheck-strict-candidate.mjs` while it is being hardened.
2. Remove package-level strictness overrides from the package `tsconfig.json`.
3. Run `pnpm guardrails:typecheck-config`, package typecheck, and `pnpm typecheck:strict-candidate`.
4. Keep `pnpm typecheck:strict-candidate` in CI as the regression gate.
