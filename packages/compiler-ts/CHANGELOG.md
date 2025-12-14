# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2025-12-01

### Added

#### Compiler (`fict-compiler-ts`)
- ✅ Complete TypeScript compiler transformer for `$state` and `$effect`
- ✅ Automatic derived value detection and memoization
- ✅ Parameter shadowing support for nested scopes
- ✅ JSX expression wrapping for reactive updates
- ✅ Compile-time safety checks:
  - Prevents `$state` declarations inside loops
  - Validates identifier assignments for `$state`
- ✅ Comprehensive test suite (78 tests)
  - Basic transformations
  - Control flow (conditionals, loops, switch)
  - Error cases
  - Integration scenarios

#### Runtime (`fict-runtime`)
- ✅ Fine-grained reactivity system with signals, memos, and effects
- ✅ DOM rendering with `render()` and `createElement()`
- ✅ Complete reactive binding API:
  - `createTextBinding` - Reactive text content
  - `createAttributeBinding` - Reactive attributes
  - `createStyleBinding` - Reactive styles with unitless property support
  - `createClassBinding` - Reactive classes (string and object notation)
  - `createChildBinding` - Reactive children
  - `createConditional` - Conditional rendering
  - `createList` - List rendering with keyed updates
- ✅ Lifecycle hooks: `onMount`, `onDestroy`, `onCleanup`, `createRoot`
- ✅ Scheduler utilities: `batch`, `untrack`
- ✅ DevTools hook for debugging
- ✅ Full test coverage (43 tests passing)

#### Vite Plugin (`fict-vite-plugin`)
- ✅ Automatic Fict compiler integration
- ✅ Dev mode detection for debugging
- ✅ Source map support
- ✅ Hot module replacement handling
- ✅ Better error messages
- ✅ Glob pattern matching for include/exclude
- ✅ Smart file filtering (skips files without 'fict' imports)

#### ESLint Plugin (`eslint-plugin-fict`)
- ✅ `no-state-in-loop` - Prevents `$state` in loops
- ✅ `no-direct-mutation` - Warns against deep mutations
- ✅ `no-empty-effect` - Warns about empty `$effect` bodies
- ✅ Recommended config with sensible defaults

#### Main Package (`fict`)
- ✅ Unified entry point for all Fict functionality
- ✅ Re-exports runtime API
- ✅ Exports compile-time macros (`$state`, `$effect`)
- ✅ JSX runtime integration
- ✅ Vite plugin export

#### Documentation
- ✅ Comprehensive README with examples and comparisons
- ✅ Quick Start guide
- ✅ State Management guide
- ✅ Working counter example app
- ✅ API documentation structure

#### Developer Experience
- ✅ Monorepo setup with pnpm workspaces
- ✅ Turborepo for fast builds
- ✅ TypeScript with strict mode
- ✅ Vitest for testing
- ✅ ESLint and Prettier
- ✅ Husky pre-commit hooks
- ✅ Changesets for versioning
- ✅ Size-limit checks (~6KB target for runtime)

### Fixed
- Fixed binding API parameter order (`createElementFn` before optional params)
- Fixed unitless CSS properties (opacity, zIndex, etc.) to not add 'px'

### Technical Details

**Compiler Architecture:**
- Two-phase compilation: state collection → transformation
- Visitor pattern with shadowing-aware scoping
- Smart memoization: creates `createMemo` for reactive contexts, plain getters for event-only usage
- JSX expression wrapping for fine-grained updates

**Runtime Architecture:**
- Pull-based reactivity graph with bidirectional links
- Efficient dependency tracking with version-based invalidation
- Batched updates via scheduler
- Direct DOM manipulation (no Virtual DOM)

**Bundle Sizes:**
- `fict-runtime`: ~6KB gzipped (ESM)
- `fict-compiler-ts`: ~19KB
- `fict-vite-plugin`: ~2KB

## [0.0.1] - 2024-11-30

### Added
- Initial project structure
- Basic signal implementation
- Prototype compiler transformer

---

## MVP Roadmap Completion

This 0.1.0 release completes the core MVP requirements:

✅ **Core Semantics & Compiler**
- Derived categorization and control-flow grouping
- Parameter shadowing and capture handling
- Compile-time safety checks
- Error messaging

✅ **Runtime/DOM**
- Binding API coverage
- Lifecycle management
- Bundle size control (≤ 6KB)

✅ **Tooling**
- Vite plugin integration
- ESLint rules
- Full test coverage

✅ **Documentation**
- README update
- Guide documentation
- Example app

## Known Limitations (To be addressed in future releases)

- No SSR/streaming support yet
- No official router
- No form library
- No component library
- Deep reactivity requires immutable updates (planned: `$store` from `fict/plus`)
- Derived values in events create memos (optimization planned: getter-only for event-only usage)

## Feedback & Contributing

This is an experimental release. Please report issues at:
https://github.com/fictjs/fict/issues
