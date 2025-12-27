# Diagnostic codes (compiler + ESLint)

These codes surface both at compile time and via `@fictjs/eslint-plugin` where applicable.

## Components

- **FICT-C003** – Nested component definitions (`no-nested-components`)
- **FICT-C004** – Component missing return (`require-component-return`)

## JSX / Lists

- **FICT-J002** – Missing `key` on elements returned from `.map()` (`require-list-key`)

## Reactivity

- **FICT-E001** – `$effect` body has no reactive reads (`no-empty-effect`)
- **FICT-M003** – `$memo` callback contains side effects (`no-memo-side-effects`)
- **FICT-S002** – `$state` escapes current scope (compiler warning; lint rule planned)

## Performance hints

- **FICT-X003** – Inline functions in JSX props (`no-inline-functions`)

## Notes

- Compiler emits additional internal codes (FICT-P\* for props lowering, etc.) that are handled during transformation and not exposed as lint rules yet.
- Keep lint and compiler versions in sync to ensure the same warning surface in editor and build logs.
