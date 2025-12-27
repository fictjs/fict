# ESLint rules for Fict

`@fictjs/eslint-plugin` ships guardrails that mirror compiler diagnostics. Install and enable the recommended config to catch issues before build time.

```bash
pnpm add -D @fictjs/eslint-plugin
```

`.eslintrc`:

```json
{
  "plugins": ["fict"],
  "extends": ["plugin:fict/recommended"]
}
```

## Rules (recommended)

| Rule                         | Diagnostic | Level | What it catches                              |
| ---------------------------- | ---------- | ----- | -------------------------------------------- |
| `no-state-in-loop`           | error      | P0    | `$state` declared inside loops               |
| `no-state-destructure-write` | error      | P0    | Writes to destructured `$state` aliases      |
| `no-nested-components`       | FICT-C003  | P0    | Components defined inside components         |
| `require-list-key`           | FICT-J002  | P0    | `.map()` returning JSX without `key`         |
| `no-direct-mutation`         | warn       | P1    | Deep mutations on `$state` objects           |
| `no-empty-effect`            | FICT-E001  | warn  | `$effect` with no reactive reads             |
| `no-inline-functions`        | FICT-X003  | warn  | Inline functions in JSX props (perf footgun) |
| `no-memo-side-effects`       | FICT-M003  | warn  | Side effects inside `$memo` callbacks        |
| `require-component-return`   | FICT-C004  | warn  | Component functions missing a return         |

## Notes

- `require-list-key` only checks elements returned directly from `.map(...)`.
- `no-empty-effect` looks for identifiers captured from outer scope; empty effects or purely local work are flagged.
- `no-memo-side-effects` warns on assignments/updates or `$effect` calls inside `$memo`.
- Keep compiler and ESLint diagnostics aligned for the best DX; see `docs/diagnostic-codes.md` for the full code list.
