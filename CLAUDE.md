# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Fict is a reactive UI library where developers write plain JavaScript and the compiler automatically handles reactivity, derived values, and DOM updates. It combines React's JSX syntax with Solid's fine-grained reactivity model, but with minimal boilerplate—no `.value` accessors, no dependency arrays, no `useMemo`.

**Key mental model**: Component functions run once during initial render. Expressions using state auto-recompute reactively. Control flow reads (if/for) trigger re-execution; JSX-only usage triggers fine-grained DOM updates.

## Common Commands

```bash
# Development
pnpm dev                    # Watch mode for all packages
pnpm build                  # Build all packages (Turbo handles dependencies)

# Testing
pnpm test                   # Run all tests
pnpm test --filter @fictjs/runtime   # Test specific package
pnpm vitest run packages/runtime/test/signal.test.ts  # Single test file
pnpm test:coverage          # With coverage reports

# Code Quality
pnpm lint                   # ESLint
pnpm lint:fix               # Fix ESLint issues
pnpm typecheck              # TypeScript validation
pnpm format                 # Prettier format
```

## Architecture

### Monorepo Structure

- **pnpm workspaces** + **Turbo** for task orchestration
- Node 20+, pnpm 9+ required

### Key Packages

| Package                  | Purpose                                               |
| ------------------------ | ----------------------------------------------------- |
| `packages/fict`          | Main entry point, public API exports                  |
| `packages/runtime`       | Core reactive runtime (signals, effects, DOM binding) |
| `packages/compiler`      | Babel plugin transforming JSX → reactive code         |
| `packages/vite-plugin`   | Vite integration wrapping the compiler                |
| `packages/eslint-plugin` | ESLint rules mirroring compiler guardrails            |

### Compilation Pipeline

1. **TSX Source** → Normal TypeScript + JSX
2. **Compiler** (`packages/compiler/src/ir/`) → Analyzes `$state`, derived expressions, JSX bindings → Produces Reactive IR
3. **Runtime** → Maps IR to signals, DOM patches, lifecycle management
4. **Browser** → Component executes once, builds dependency graph, triggers surgical updates

### Core APIs

- `$state()` - Reactive signal (shallow)
- `$store()` - Reactive proxy (deep, for nested objects)
- `$effect()` - Side effect with cleanup
- Derived values are automatic—no useMemo needed
- `fict/plus` exports: `ErrorBoundary`, `Suspense`, `resource()`, `lazy()`

### Execution Model

```tsx
function Component() {
  // Code BEFORE $state → runs once only
  let count = $state(0)

  // Expressions USING state → recompute reactively
  const doubled = count * 2

  // Control flow READING state → triggers component re-execution
  if (doubled > 10) {
    /* ... */
  }

  // JSX-only reads → fine-grained DOM updates only
  return <button>{count}</button>
}
```

## Compiler Diagnostics

Diagnostic codes (FICT-P*, FICT-C*, FICT-J\*, etc.) surface at compile time and via `@fictjs/eslint-plugin`. See `docs/diagnostic-codes.md` for the full reference.

Key codes:

- **FICT-C003**: Nested component definitions (avoid defining components inside components)
- **FICT-J002**: Missing list keys
- **FICT-P001**: Props destructuring fallback (complex patterns have runtime overhead)

## Commit Convention

Use conventional commits with scopes:

```bash
pnpm commit  # Interactive commit helper

# Format: type(scope): message
# Examples:
feat(runtime): add batch update support
fix(compiler): handle edge case in JSX transform
docs: update API reference
```

Valid scopes: runtime, compiler, vite-plugin, eslint-plugin, fict, router, ssr, devtools, testing-library, docs-site, examples, deps, release, others
