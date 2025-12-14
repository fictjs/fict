# Conditional Rendering + Fragment Plan (TODO List)

This file tracks the steps to support conditional rendering with fine-grained DOM using a Fragment + render-driver + slot-based hooks approach. Items marked as ✅ are already implemented.

## Scope

- Goal: Conditional branches re-evaluate and switch DOM without re-running the entire component body; signals/memos/effects are reused via slots/keys.
- Approach: Fragment wrapper + render driver + runtime conditional helper; compiler rewrites hooks to slot-based APIs.

## Completed

- ✅ Compiler: Top-level `if (cond) return A; return B;` lowered to `__fictConditional(...).marker`.
- ✅ Compiler: Reactive expression statements before that pattern wrapped in `__fictEffect(() => expr)` so effects rerun on deps (fixes doubled log in counter integration test).
- ✅ Tests: All suites green (`@fictjs/compiler`, `@fictjs/runtime`, `fict` including `compiler-counter-integration.test.ts`).
- ✅ Doc: `docs/fragment-conditional-fine-grained.md` describing the target architecture.

## Remaining TODOs

1. **Runtime primitives** ✅
   - Added `__fictUseContext` (per-component instance context stack).
   - Added `__fictRender(ctx, fn)` (wraps fn, pushes ctx, tracks deps via effect, re-runs on change, reuses slots).
   - Added slot-based APIs: `__fictUseSignal/__fictUseMemo/__fictUseEffect` (per-slot reuse, stable across reruns).
   - Effects run through scheduler; cleanup behavior remains from core effect API.

2. **Runtime conditional helper alignment**
   - Either reuse/extend existing `createConditional` to support returned marker/root for compiler use, or add a dedicated helper (`__fictConditional`) that manages mount/unmount/switch.
   - Guarantee DOM branch switching + cleanup is correct and compatible with fine-grained bindings.

3. **Compiler hook rewrite**
   - Inject component ctx; wrap component return with `_Fragment` + `__fictRender(__ctx, fn)`.
   - Rewrite `$state/$memo/$effect` (including Rule D region memos) to slot-based `__fictUse*(__ctx, ..., slotOrKey)`.
   - Choose slot strategy: sequential slots (with lint guard) or stable keys (identifier + source offset).

4. **Conditional lowering (general)**
   - Beyond top-level `if/return`, detect broader conditional patterns and lower to `__fictConditional` while preserving fine-grained DOM lowering.
   - Ensure branches’ fine-grained bindings remain intact.

5. **Rule D/J alignment**
   - Make region grouping/lazy conditional aware of the render wrapper; avoid double wrapping or skipped deps.
   - Confirm region outputs/memos integrate with slot reuse.

6. **Lint/guardrails**
   - Add ESLint rule to prevent slot drift: disallow adding/removing `$state/$memo/$effect` in dynamic control flow that would change ordering.
   - Compiler diagnostics/fallback for unsupported control-flow shapes.

7. **Testing**
   - Add dedicated tests for slot reuse across reruns (signals/memos/effects not recreated).
   - Add tests for conditional branch switching (DOM mount/unmount) with fine-grained bindings.
   - Keep existing suites green; extend integration tests to cover Fragment/render driver path.

8. **Docs**
   - Update `fragment-conditional-fine-grained.md` after runtime/compiler changes to match actual API names and behaviors.

## Notes

- Current behavior: only simple top-level `if/return` is auto-lowered; everything else remains as before.
- Focus: correctness of slot reuse + conditional DOM switching; minimize user constraints beyond slot-order lint.
