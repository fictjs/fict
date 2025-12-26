# Spec ↔ Test Matrix (v1.x)

Quick lookup from spec sections to the tests that pin the behavior. Keep this file updated whenever semantics change or new coverage is added.

## Compiler

- **$state placement / $effect placement** (`compiler-spec.md` §3.2 / §4.1)
  - Tests: `packages/compiler/test/semantic-validation.test.ts` (placement errors), `packages/compiler/test/base-transform.test.ts` (loop/conditional rejections)
- **$state destructuring = hard error** (`compiler-spec.md` §3.1.2)
  - Tests: `packages/compiler/test/base-transform.test.ts` — “throws error for $state with destructuring”
- **Alias semantics & getter rewriting** (`compiler-spec.md` §3.4)
  - Tests: `packages/compiler/test/spec-rules.test.ts` — alias cases; `packages/compiler/test/alias-reactivity.test.ts`
- **Derived/control-flow region grouping (Rule D)** (`compiler-spec.md` §7)
  - Tests: `packages/compiler/test/rule-d-verify.test.ts`, `packages/compiler/test/control-flow.test.ts`
- **Event/closure capture = live reads** (`compiler-spec.md` §5.2)
  - Tests: `packages/compiler/test/spec-rules.test.ts` — event snapshot vs live; `packages/compiler/test/transform.test.ts` — event swap repro
- **Illegal patterns (assign to $state(), placement errors)** (`compiler-spec.md` §3.2.1)
  - Tests: `packages/compiler/test/semantic-validation.test.ts`, `packages/compiler/test/base-transform.test.ts`
- **Cross-module derived export/import** (`compiler-spec.md` §8)
  - Tests: `packages/compiler/test/cross-module.test.ts`
- **Warning codes** (`compiler-spec.md` §11)
  - Tests: `packages/compiler/test/spec-rules.test.ts`, `packages/compiler/test/base-transform.test.ts` (FICT-H / FICT-M)
- **Fine-grained JSX lowering (texts/attrs/refs/events/properties)** (`fine-grained-jsx-subset.md`)
  - Tests: `packages/compiler/test/transform.test.ts` (refs, property binding), `packages/compiler/test/spec-complete.test.ts`
- **Keyed list lowering to block helpers** (`fine-grained-jsx-subset.md` §3.3)
  - Tests: `packages/compiler/test/transform.test.ts` — keyed list lowering; `packages/compiler/test/control-flow.test.ts`

## Runtime

- **Signal/memo/effect semantics** (`architecture.md` §2–4)
  - Tests: `packages/runtime/test/index.test.ts`, `packages/runtime/test/scheduler.test.ts`, `packages/runtime/test/effect` cases
- **Lifecycle (onMount/onDestroy) and render** (`architecture.md` §6)
  - Tests: `packages/runtime/test/index.test.ts`, `packages/runtime/test/memory-lifecycle.test.ts`
- **Keyed list identity & block moves** (`architecture.md` §10)
  - Tests: `packages/runtime/test/keyed-list-e2e.test.ts`, `packages/runtime/test/nested-keyed-list-e2e.test.ts`, `packages/runtime/test/list-helpers.test.ts`
- **Fine-grained property/attribute bindings** (`architecture.md` §7)
  - Tests: `packages/runtime/test/property-binding.test.tsx`, `packages/runtime/test/binding.test.ts`
- **Refs with cleanup** (`architecture.md` §7)
  - Tests: `packages/runtime/test/ref.test.ts`
- **Cycle protection options** (`cycle-protection.md`)
  - Tests: `packages/runtime/test/cycle-protection.test.ts`, `packages/runtime/test/index.test.ts` (export smoke)

## Library Facade (fict)

- **Plus exports / scheduling helpers** (`architecture.md` §7.2)
  - Tests: `packages/fict/test/plus-exports.test.ts`
- **JSX runtimes** (`compiler-spec.md` intro)
  - Tests: `packages/runtime/test/index.test.ts` (jsx-dev-runtime smoke)
