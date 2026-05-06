# Reactivity Guarantee Matrix

This matrix defines the current guarantee boundary for Fict compiler behavior.

- `Guaranteed`: expected to remain reactive and predictable under `strictGuarantee`.
- `Fallback`: behavior is still correctness-first reactive, but not guaranteed fine-grained; these diagnostics are errors by default under `strictGuarantee`.
- `Unsupported`: compile-time rejected patterns.
- `Out of model`: runtime/external behavior outside compiler guarantees.

## Enforce In CI

```bash
FICT_STRICT_GUARANTEE=1 pnpm build
```

`FICT_STRICT_GUARANTEE=1` forces compiler `strictGuarantee` globally (even when options opt out).

## Matrix

| Category     | Pattern                                                                                    | Contract                                                            | Diagnostic / Failure Mode    |
| ------------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- | ---------------------------- |
| Guaranteed   | Top-level `$state`/`$effect` in component or hook body                                     | Reactive and supported                                              | N/A                          |
| Guaranteed   | Reactive derived bindings (`const doubled = count * 2`)                                    | Reactive and supported                                              | N/A                          |
| Guaranteed   | JSX event handlers capturing reactive values                                               | Supported (non-escaping closure)                                    | N/A                          |
| Guaranteed   | Common synchronous iterator callbacks (`map`/`filter`/`forEach`) capturing reactive values | Supported (non-escaping callback host)                              | N/A                          |
| Fallback     | Props destructuring fallback shapes (rest/computed/nested dynamic)                         | Blocked by default; allowed only when `strictGuarantee: false`      | `FICT-P001` - `FICT-P005`    |
| Fallback     | Reactive value escape to unknown call boundary                                             | Blocked by default; allowed only when `strictGuarantee: false`      | `FICT-R002`                  |
| Fallback     | Reactive closure/callback escape to unknown or async host                                  | Blocked by default; allowed only when `strictGuarantee: false`      | `FICT-R002`, `FICT-R005`     |
| Fallback     | Control-flow fallback / widened re-execution                                               | Blocked by default; allowed only when `strictGuarantee: false`      | `FICT-R003`, `FICT-R006`     |
| Fallback     | Native element spread with unknown shape                                                   | Blocked by default; allowed only when `strictGuarantee: false`      | `FICT-J003`                  |
| Fallback     | Escaped state lifetime risk                                                                | Blocked by default; allowed only when `strictGuarantee: false`      | `FICT-S002`                  |
| Unsupported  | `$state` / `$effect` inside loops or conditionals                                          | Compile-time error                                                  | Placement validation error   |
| Unsupported  | `$state` / `$effect` inside nested functions                                               | Compile-time error                                                  | Placement validation error   |
| Unsupported  | Invalid `$state` assignment patterns (`const {x} = $state(...)`)                           | Compile-time error                                                  | Macro usage validation error |
| Out of model | `eval` / `new Function` / highly dynamic reflection                                        | Not statically provable                                             | No full guarantee            |
| Out of model | External direct DOM mutation / unstable external node ownership                            | Runtime invariant may be broken                                     | No compiler guarantee        |
| Out of model | Third-party package hooks without `package.json#fict` metadata                             | Import stays opaque; compiler cannot recover hook return reactivity | No auto-recovery guarantee   |

## Notes

- `strictReactivity` is narrower than `strictGuarantee`; it focuses on control-flow fallbacks (`FICT-R003`, `FICT-R006`).
- `strictGuarantee` blocks suppression and downgrade for covered guarantee diagnostics.
- Set `strictGuarantee: false` only when intentionally opting out of fail-closed guarantees.
- Control-flow fallback remains semantic-first when explicitly allowed: tracked active branch reads remount branch output instead of attempting partial DOM patching. DOM identity inside that branch is not guaranteed.
- `Promise.then` / `catch` / `finally` callbacks are async host boundaries, not guaranteed synchronous iterator callbacks.
- Package hook reactivity across npm boundaries requires compiler metadata generated by the package build and declared through `package.json#fict.metadata` or `package.json#fict.exports`.
