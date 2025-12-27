# Changelog

All notable changes to this project will be documented in this file by Changesets.

## [0.1.0](https://github.com/fictjs/fict/compare/v0.0.1...v0.1.0) (2025-12-27)

### Features

  - HIR-first compiler: Default lowering now produces runnable fine‑grained DOM with structured control flow, preserved top-level statements, and SSA-aware reactivity. Legacy paths removed.
  - Stable $state / $effect: Placement rules enforced (module/component top-level only); loops/conditionals validation; control-flow re-execution aligned with region metadata; do/while/for loop stack fixes for break/continue.
  - Context safety: New hook context push/pop for modules prevents cross-module slot collisions; __fictCtx auto-injected where needed.
  - Cross-module derived values: Exported state/derived memos stay reactive across modules; integration test added (state + memo + event consumer).
  - JSX & conditions: Fine-grained DOM path covers spreads, refs, style/class, keyed lists, nested conditionals; conditional rendering uses runtime helpers with proper cleanup and memo reuse.
  - Props DX: Compiler auto-wraps prop getters (prop/useProp/mergeProps hidden for common cases); rest/spread patterns handled; integration tests cover implicit wrapping.
  - Hook ergonomics: Hook-style helpers returning accessors (object, single accessor, rest spread) compile and run correctly; destructuring supported.
  - Dev diagnostics: Unified FICT_DEBUG flags; warnings for deep mutations/dynamic access; new warning when $effect has no reactive reads.
  - Structurization resilience: CFG structurizer falls back to state-machine mode on unsupported shapes to preserve correctness (e.g., edge do-while+continue cases).
  - Runtime correctness: Region/Dependency analysis applied to DOM bindings; helper auto-imports wired for HIR; applyRegionMetadata active.
  - Tests: Compiler and runtime suites are green (pnpm --filter compiler test, pnpm --filter fict test); cross-module integration added.
  - Breaking changes: Legacy compiler path removed; users should rely on $state/$effect top-level semantics and fine-grained JSX output. Context helpers renamed in emitted code (__fictPushContext/__fictPopContext usage internally).
