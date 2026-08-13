# Fict Real Apps Example

Production-shaped UI surfaces for validating v1 workflows:

- Form-heavy procurement intake with validation and review state
- Operations dashboard with segmented time ranges and dense tables
- Nested router workspace using `@fictjs/router`
- Async fleet monitor using the canonical `fict/plus` `resource`, loading state, and refresh
- Auth, loading, and error recovery flow using local state and `ErrorBoundary`

Together with the production-built resumable and streaming SSR examples, this
application forms the continuous real-application validation suite described in
[`docs/testing/real-application-validation.md`](../../docs/testing/real-application-validation.md).

## Run

```bash
pnpm -C examples/real-apps dev
pnpm -C examples/real-apps build
pnpm test:real-apps
pnpm test:real-apps:long
```
