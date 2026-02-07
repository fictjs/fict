# Reactivity Guarantee Matrix

This matrix defines the current guarantee boundary for Fict compiler behavior.

- `Guaranteed`: expected to remain reactive and predictable under `strictGuarantee`.
- `Fallback`: behavior is still correctness-first reactive, but not guaranteed fine-grained; `strictGuarantee` treats these diagnostics as errors.
- `Unsupported`: compile-time rejected patterns.
- `Out of model`: runtime/external behavior outside compiler guarantees.

## Enforce In CI

```bash
FICT_STRICT_GUARANTEE=1 pnpm build
```

`FICT_STRICT_GUARANTEE=1` forces compiler `strictGuarantee` globally.

## Matrix

| Category     | Pattern                                                                        | Contract                                             | Diagnostic / Failure Mode    |
| ------------ | ------------------------------------------------------------------------------ | ---------------------------------------------------- | ---------------------------- |
| Guaranteed   | Top-level `$state`/`$effect` in component or hook body                         | Reactive and supported                               | N/A                          |
| Guaranteed   | Reactive derived bindings (`const doubled = count * 2`)                        | Reactive and supported                               | N/A                          |
| Guaranteed   | JSX event handlers capturing reactive values                                   | Supported (non-escaping closure)                     | N/A                          |
| Guaranteed   | Common iterator callbacks (`map`/`filter`/`forEach`) capturing reactive values | Supported (non-escaping callback host)               | N/A                          |
| Fallback     | Props destructuring fallback shapes (rest/computed/nested dynamic)             | Allowed by default, blocked in strict guarantee mode | `FICT-P001` - `FICT-P005`    |
| Fallback     | Reactive value escape to unknown call boundary                                 | Allowed by default, blocked in strict guarantee mode | `FICT-R002`                  |
| Fallback     | Control-flow fallback / widened re-execution                                   | Allowed by default, blocked in strict guarantee mode | `FICT-R003`, `FICT-R006`     |
| Fallback     | Native element spread with unknown shape                                       | Allowed by default, blocked in strict guarantee mode | `FICT-J003`                  |
| Fallback     | Escaped state lifetime risk                                                    | Allowed by default, blocked in strict guarantee mode | `FICT-S002`                  |
| Unsupported  | `$state` / `$effect` inside loops or conditionals                              | Compile-time error                                   | Placement validation error   |
| Unsupported  | `$state` / `$effect` inside nested functions                                   | Compile-time error                                   | Placement validation error   |
| Unsupported  | Invalid `$state` assignment patterns (`const {x} = $state(...)`)               | Compile-time error                                   | Macro usage validation error |
| Out of model | `eval` / `new Function` / highly dynamic reflection                            | Not statically provable                              | No full guarantee            |
| Out of model | External direct DOM mutation / unstable external node ownership                | Runtime invariant may be broken                      | No compiler guarantee        |

## Notes

- `strictReactivity` is narrower than `strictGuarantee`; it focuses on control-flow fallbacks (`FICT-R003`, `FICT-R006`).
- `strictGuarantee` blocks suppression and downgrade for covered guarantee diagnostics.
- `FICT-R005` is currently warning-only and intentionally excluded from strict guarantee hard blocking until precision targets are met.
