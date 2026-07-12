# Examples

The repository examples are runnable reference applications. From a repository checkout, install dependencies with `pnpm install`, then start an example with `pnpm --dir examples/<name> dev` (or its package-specific build script).

## Core Apps

- `examples/counter-basic`: minimal Vite counter.
- `examples/todos`: local state list management.
- `examples/forms`: standalone form validation.
- `examples/async-data`: resource loading with Suspense and ErrorBoundary.
- `examples/real-apps`: form-heavy procurement flow, dashboard, nested router, and auth/error/loading surfaces.

## SSR and Resumability

- `examples/ssr-basic`: resumable SSR page with lazy event handlers.
- `examples/ssr-streaming`: shell-first SSR streaming page with Suspense patching.

## Tooling

- `examples/counter-webpack`: Webpack build smoke.
- `examples/fict-library`: library packaging example.

## What to open first

1. Start with `counter-basic` to verify compiler and JSX setup.
2. Move to `todos` and `forms` for state, lists, and validation.
3. Use `async-data` for `resource`, Suspense, and ErrorBoundary behavior.
4. Use `real-apps` when evaluating routing and application-scale composition.

Repository verification scripts build the compiler smoke examples and the larger real/SSR applications. Individual example packages also expose their own `dev` or `build` scripts where applicable.
