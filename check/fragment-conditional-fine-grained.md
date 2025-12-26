# Fragment-Wrapped Conditional Rendering (Fine-Grained)

This document captures the proposed design to support **conditional rendering with fine-grained DOM** while **reusing signal/memo/effect instances** via a hooks-like slot mechanism. The goal is to keep React-like authoring ergonomics but make conditional branches re-evaluate and switch DOM correctly.

## Motivation

- Today the component body is assumed to run once. `if`/`return` branches are chosen on first render and never re-evaluated, so conditional DOM does not switch.
- We need DOM to update when tracked deps change, without recreating signals/effects/memos (hot reload and runtime correctness).
- We want minimal user constraints beyond “keep `$state/$effect/$memo` in stable order”, enforced by ESLint.

## Core Design

1. **Fragment wrapper + render driver**
   - Component returns `_Fragment` whose `children` is a render function driven by `__fictRender(ctx, fn)`.
   - `__fictRender` (now implemented) pushes ctx, runs `fn`, and installs an effect to re-run on dependency changes while reusing slot instances.

2. **Hooks-like slot reuse**
   - Compiler rewrites `$state/$memo/$effect` (including Rule D region memos) to `__fictUseSignal/__fictUseMemo/__fictUseEffect` with a stable slot index per declaration.
   - Runtime keeps per-instance context array; on re-run, instances are reused instead of recreated.
   - ESLint rule (TODO): no adding/removing `$state/$effect/$memo` in dynamic control flow to avoid slot drift.

3. **Runtime conditional helper**
   - Conditional DOM switching is handled by `__fictConditional(condFn, trueMount, createElementAlias, falseMount?)`.
   - It subscribes to `condFn` deps, mounts/unmounts/rehydrates the appropriate branch DOM.
   - Branch bodies still use fine-grained bindings (e.g., `__fictBindText`).

4. **Fine-grained DOM stays inline**
   - JSX lowering remains the current inline DOM creation style; only the outer wrapping and hooks calls change.

## Example Output (conceptual)

```js
function Counter() {
  const __ctx = __fictContext()
  return _jsx(_Fragment, {
    children: __fictRender(__ctx, () => {
      const count = __fictSignal(__ctx, 0, /*slot=*/ 0)
      const count1 = __fictSignal(__ctx, 0, /*slot=*/ 1)
      const doubled = __fictMemo(__ctx, () => count() * 2, /*slot=*/ 2)
      __fictEffect(
        __ctx,
        () => {
          document.title = `Count: ${count()}`
        },
        /*slot=*/ 3,
      )

      return __fictConditional(
        () => !(count() % 2),
        () => {
          /* fine-grained DOM for even branch, uses __fictBindText, etc. */
        },
        __fictCreateElement,
        () => {
          /* fine-grained DOM for odd branch */
        },
      )
    }),
  })
}
```

## Compiler Work

- Wrap component return with `_Fragment` + `__fictRender(__ctx, fn)`.
- Rewrite `$state/$memo/$effect` to `__fict*(__ctx, ..., slot)`(`__fictSignal/__fictMemo/__fictEffect`); slots assigned by declaration order (or stable key: identifier + source offset).
- Generate `__fictConditional` for conditional patterns; keep existing Rule D/J analyses but ensure they run inside the render function.
- Keep fine-grained DOM lowering unchanged inside branches.
- Emit runtime imports for the new helpers.

## Runtime Work

- Add `__fictContext`, `__fictRender`, `__fictSignal`, `__fictMemo`, `__fictEffect` with per-instance slot arrays.
- Implement `__fictConditional` that mounts/unmounts/switches DOM branches on dep change.
- Ensure effects clean up on unmount; signals/memos persist across `__fictRender` re-runs.

## Constraints & Guardrails

- Hook-like ordering is required only for `$state/$memo/$effect`; enforce via ESLint rule (no dynamic addition/removal in branches/loops).
- For unsupported control flow, compiler should error or fall back (no silent miscompilation).
- Rule D/J must be aware of the render wrapper to avoid double-wrapping or skipping deps.

## Risks

- Slot drift if users violate the ordering rule → state/memo/effect misaligned. Mitigate with lint + compile-time checks.
- Conditional helper correctness: must reliably swap DOM branches and clean up to avoid leaks or stale nodes.
- Interaction with existing optimizations (Rule D/J) when wrapped in `__fictRender`; needs thorough tests.

## Testing Plan

- Unit: slot reuse across re-runs; conditional branch switching updates DOM and text bindings.
- Integration: scenarios like the `conditionalCounter` (count/count1, title update, branch swap) validating logs and DOM.
- Negative: lint/compile errors when `$state/$memo/$effect` are placed in dynamic control flow that changes ordering.
