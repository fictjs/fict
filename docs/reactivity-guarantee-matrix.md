# Reactivity Guarantee Matrix

This matrix defines the current guarantee boundary for Fict compiler behavior.
For v1.0, this document is the normative Reactivity Contract. Every
`Guaranteed` row must have a passing strict-mode test, and every `Fallback` row
must have an explicit default behavior plus a diagnostic that is blocked by
`strictGuarantee`.

- `Guaranteed`: expected to remain reactive and predictable under `strictGuarantee`.
- `Fallback`: behavior is still correctness-first reactive, but not guaranteed fine-grained; these diagnostics are errors by default under `strictGuarantee`.
- `Unsupported`: compile-time rejected patterns.
- `Out of model`: runtime/external behavior outside compiler guarantees.

## Enforce In CI

```bash
FICT_STRICT_GUARANTEE=1 pnpm build
```

`FICT_STRICT_GUARANTEE=1` forces compiler `strictGuarantee` globally (even when options opt out).
Production compilation (`NODE_ENV=production`) also forces `strictGuarantee` on;
dev/test migration experiments may opt out only outside production.

## Matrix

| Category     | Pattern                                                                                    | Contract                                                                                                    | Diagnostic / Failure Mode    |
| ------------ | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Guaranteed   | Top-level `$state`/`$effect` in component or hook body                                     | Reactive and supported                                                                                      | N/A                          |
| Guaranteed   | Reactive derived bindings (`const doubled = count * 2`)                                    | Reactive and supported                                                                                      | N/A                          |
| Guaranteed   | JSX event handlers capturing reactive values                                               | Supported (non-escaping closure)                                                                            | N/A                          |
| Guaranteed   | Common synchronous iterator callbacks (`map`/`filter`/`forEach`) capturing reactive values | Supported (non-escaping callback host)                                                                      | N/A                          |
| Guaranteed   | Supported branch returns (`if-return` / `switch-return` / equivalent `try` returns)        | Reactive branch bindings under default `strictGuarantee`                                                    | N/A                          |
| Guaranteed   | Memoized control-flow story blocks assigning locals consumed by JSX                        | Reactive region memo under default `strictGuarantee`                                                        | N/A                          |
| Guaranteed   | Story blocks containing `try`/`catch` (including throws caught by the block's own handler) | Reactive region memo under default `strictGuarantee`                                                        | N/A                          |
| Guaranteed   | Structured hook control flow assigning observable locals (`if`/`switch`/loop forms)        | Declarations and control flow execute together in one live memo region; captured reads stay current         | N/A                          |
| Fallback     | Props destructuring fallback shapes (rest/computed/nested dynamic)                         | Blocked by default; allowed only in non-production opt-out builds                                           | `FICT-P001` - `FICT-P005`    |
| Fallback     | JSX built imperatively inside loop bodies                                                  | Blocked by default; opt-out builds render the loop once as a static fallback (no reactive updates) and warn | `FICT-R006`                  |
| Fallback     | Reactive value escape to unknown call boundary                                             | Blocked by default; allowed only in non-production opt-out builds                                           | `FICT-R002`                  |
| Fallback     | Reactive closure/callback escape to unknown or async host                                  | Blocked by default; allowed only in non-production opt-out builds                                           | `FICT-R002`, `FICT-R005`     |
| Fallback     | Call-based, late-inferred hook-accessor, or unsupported control-flow fallback              | Blocked by default; allowed only in non-production opt-out builds                                           | `FICT-R006`                  |
| Fallback     | Native element spread with unknown shape                                                   | Blocked by default; allowed only in non-production opt-out builds                                           | `FICT-J003`                  |
| Fallback     | Escaped state lifetime risk                                                                | Blocked by default; allowed only in non-production opt-out builds                                           | `FICT-S002`                  |
| Unsupported  | `$state` / `$effect` inside loops or conditionals                                          | Compile-time error                                                                                          | Placement validation error   |
| Unsupported  | `$state` / `$effect` inside nested functions                                               | Compile-time error                                                                                          | Placement validation error   |
| Unsupported  | Invalid `$state` assignment patterns (`const {x} = $state(...)`)                           | Compile-time error                                                                                          | Macro usage validation error |
| Out of model | `eval` / `new Function` / highly dynamic reflection                                        | Not statically provable                                                                                     | No full guarantee            |
| Out of model | Runtime value violates a direct built-in `$state<T>` receiver contract                     | The type argument is a caller-owned proof obligation; the compiler adds no runtime family check             | Native JavaScript failure    |
| Out of model | External direct DOM mutation / unstable external node ownership                            | Runtime invariant may be broken                                                                             | No compiler guarantee        |
| Out of model | Third-party package hooks without `package.json#fict` metadata                             | Import stays opaque; compiler cannot recover hook return reactivity                                         | No auto-recovery guarantee   |

## Notes

- `strictReactivity` is narrower than `strictGuarantee`; it focuses on the `FICT-R006` control-flow fallback.
- `strictGuarantee` blocks suppression and downgrade for covered guarantee diagnostics.
- Set `strictGuarantee: false` only when intentionally opting out of fail-closed guarantees outside production.
- Control-flow fallback remains semantic-first when explicitly allowed: tracked active branch reads remount branch output instead of attempting partial DOM patching. DOM identity inside that branch is not guaranteed.
- Structured synchronous hook control flow can export mutable locals through a live memo region when every declaration can move with the dispatcher and the construct contains no authored `return` or `throw`. Loop accumulators and loop-local counters are recomputed atomically, so captured reads cannot retain a first-call snapshot.
- Exception to the "correctness-first reactive" fallback wording: JSX built imperatively inside loop bodies cannot be re-executed per iteration, so opt-out builds lower it as a one-shot static render. Every iteration paints correctly on mount, the section never updates afterwards, and the compiler emits a loop-specific `FICT-R006` warning. Use a list expression (`items.map(...)` inside JSX) for reactive lists.
- A `return` inside a story block (or a throw not caught within the block itself) still disqualifies region memoization; only throws caught by the block's own `catch` handler are contained.
- Runtime no longer treats plain zero-argument functions as reactive getters. Compiler-generated getters are explicitly marked; hand-authored low-level getters must use `reactive(fn)`.
- `Promise.then` / `catch` / `finally` callbacks are async host boundaries, not guaranteed synchronous iterator callbacks.
- Package hook reactivity across npm boundaries requires compiler metadata generated by the package build and declared through `package.json#fict.metadata` or `package.json#fict.exports`.
