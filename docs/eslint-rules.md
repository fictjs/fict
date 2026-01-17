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

| Rule                               | Diagnostic     | Level | What it catches                                   |
| ---------------------------------- | -------------- | ----- | ------------------------------------------------- |
| `no-state-in-loop`                 | error          | P0    | `$state` declared inside loops                    |
| `no-state-destructure-write`       | error          | P0    | Writes to destructured `$state` aliases           |
| `no-nested-components`             | FICT-C003      | P0    | Components defined inside components              |
| `require-list-key`                 | FICT-J002      | P0    | `.map()` returning JSX without `key`              |
| `no-direct-mutation`               | warn           | P1    | Deep mutations on `$state` objects                |
| `no-empty-effect`                  | FICT-E001      | warn  | `$effect` with no reactive reads                  |
| `no-inline-functions`              | FICT-X003      | warn  | Inline functions in JSX props (perf footgun)      |
| `no-memo-side-effects`             | FICT-M003      | warn  | Side effects inside `$memo` callbacks             |
| `require-component-return`         | FICT-C004      | warn  | Component functions missing a return              |
| `no-unsafe-props-spread`           | FICT-P005      | warn  | JSX spreads with dynamic or unsafe sources        |
| `no-unsupported-props-destructure` | FICT-P001–P004 | warn  | Props destructuring patterns that lose reactivity |
| `no-computed-props-key`            | FICT-P003      | warn  | Computed keys in props destructuring              |
| `no-third-party-props-spread`      | FICT-P005      | warn  | Spreads of third-party objects into props         |

## Notes

- `require-list-key` only checks elements returned directly from `.map(...)`.
- `no-empty-effect` looks for identifiers captured from outer scope; empty effects or purely local work are flagged.
- `no-memo-side-effects` warns on assignments/updates or `$effect` calls inside `$memo`.
- Keep compiler and ESLint diagnostics aligned for the best DX; see `docs/diagnostic-codes.md` for the full code list.

## Rule Options

### `no-unsafe-props-spread`

Optionally treat imported accessors as safe spread sources when they come from other modules.

```json
{
  "rules": {
    "fict/no-unsafe-props-spread": [
      "warn",
      {
        "accessorNames": ["count", "getProps"],
        "accessorModules": ["./state", "@app/state"]
      }
    ]
  }
}
```

### `no-third-party-props-spread`

Flags JSX spreads that are directly rooted in imports from non-relative modules (excluding the allowlist and internal prefixes).
This rule is intentionally conservative: it ignores call expressions and does not chase local aliases to avoid false positives.
Set `includeCallExpressions` if you want to warn on `...thirdParty()` or `...thirdParty.getProps()` patterns.

```json
{
  "rules": {
    "fict/no-third-party-props-spread": [
      "warn",
      {
        "allow": ["@fictjs/runtime", "shared-config"],
        "internalPrefixes": ["@/", "~/"],
        "includeCallExpressions": true
      }
    ]
  }
}
```
