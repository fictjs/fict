# Contributing to Fict

Thank you for your interest in contributing to Fict!

## Prerequisites

- Node.js 20+
- pnpm 9+

## Development Setup

```bash
# Clone the repository
git clone https://github.com/fictjs/fict.git
cd fict

# Install dependencies
pnpm install

# Install git hooks
pnpm prepare

# Start development
pnpm dev
```

## Project Structure

- `packages/runtime` - Core reactive runtime
- `packages/compiler-ts` - TypeScript compiler
- `packages/vite-plugin` - Vite integration
- `packages/eslint-plugin` - ESLint rules
- `packages/devtools` - Browser DevTools
- `packages/docs-site` - Documentation website
- `examples/` - Example applications

## Development Workflow

### Running Tests

```bash
pnpm test           # Run all tests
pnpm test:watch     # Watch mode
pnpm test:coverage  # With coverage
```

### Fine-grained DOM defaults

- The TypeScript transformer now emits fine-grained DOM bindings by default; set `fineGrainedDom: false` in your `tsconfig` plugin entry only when bisecting regressions.
- The runtime also defaults to the fine-grained path. Call `disableFineGrainedRuntime()` before `render()` in local repros if you need to compare against the legacy rerender implementation, then re-enable it afterwards.

### Code Quality

```bash
pnpm lint          # ESLint
pnpm typecheck     # TypeScript
pnpm format        # Prettier
```

### Building

```bash
pnpm build                    # Build all packages
pnpm build --filter fict-runtime  # Build specific package
```

## Commit Convention

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`

Scopes: `runtime`, `compiler`, `compiler-ts`, `compiler-swc`, `vite-plugin`, `eslint-plugin`, `devtools`, `docs`, `examples`, `deps`, `release`

Examples:

- `feat(runtime): add batch update support`
- `fix(compiler): handle edge case in JSX transform`
- `docs: update API reference`

## Creating a Changeset

When making changes that should be released:

```bash
pnpm changeset
```

Follow the prompts to:

1. Select changed packages
2. Choose version bump type
3. Write a summary

## Pull Request Process

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/amazing-feature`)
3. Make your changes
4. Add tests for new functionality
5. Ensure all tests pass (`pnpm test`)
6. Add a changeset if needed (`pnpm changeset`)
7. Commit your changes
8. Push to your fork
9. Open a Pull Request

## Code of Conduct

Please be respectful and constructive in all interactions.

## Questions?

Open an issue or start a discussion on GitHub.
