---
type: adr
title: ADR-0005 — Invoke function-valued state through its accessor
description: Preserve Babel 0.28 authored-call semantics for state bindings proven to contain callable values.
owner: unadlib
status: accepted
risk_level: high
tags: [compiler, reactivity, state, compatibility]
---

# ADR-0005 — Invoke function-valued state through its accessor

## Context

Fict compiles a state binding into a runtime accessor function. That creates an
ambiguity when the state value is itself a function: an authored `callback()`
could either read the backing accessor or invoke the function stored in state.

Babel compiler 0.28 resolved a binding proven to contain a callable value as an
invocation of that value. A chain such as `$state(() => next() + 1)` therefore
kept invoking each stored function. The native compiler previously consumed the
authored call as the accessor read, returning the function object and rendering
no final value in the audited chain.

## Decision

Preserve the Babel 0.28 value-level call contract. When direct initialization
or assignment proves that a state binding contains a function, an authored
call invokes the stored function:

```tsx
let callback = $state(() => 3)
callback() // emitted as callback()()
callback?.() // emitted as callback()?.()
```

The first generated call reads the runtime accessor; the second is the
authored call. Arguments, optional-call behavior, receiver behavior, evaluation
order, and thrown errors belong to the stored function invocation.

When the compiler has no callable-value proof, `state()` retains the existing
low-level accessor-read meaning. Callable facts MUST follow direct function
initializers and assignments without spreading to unrelated aliases or plain
functions. If a future public API needs an unambiguous way to read a stored
function without invoking it, it requires a separate explicit primitive rather
than changing this established call syntax.

## Options considered

### Treat every authored call as an accessor read

Rejected. It breaks released function-valued state code and makes nested
callable state chains silently produce function objects instead of values.

### Always emit two calls for every state binding

Rejected. Non-function state values are routinely read with `state()` in
low-level and generated code. Blindly invoking the returned value would turn a
valid read into a runtime type error.

### Reject function values in `$state`

Rejected. Function values are a supported JavaScript value category used for
callbacks, strategies, and deferred work. The compiler can model the direct
callable cases without banning them.

## Consequences

- Babel 0.28 callable-state applications retain their observable result.
- The compiler carries an explicit `call_value` fact through HIR and EmitIR so
  the OXC rewriter cannot accidentally consume the authored call.
- Dynamic changes between callable and non-callable values retain ordinary
  JavaScript runtime failure behavior.
- Tests must cover direct, optional, chained, reassigned, and unrelated-call
  cases at both code-generation and runtime levels.

## Verification

The source fixture from the migration audit renders `3` through three nested
function-valued state reads. Pipeline tests assert the accessor/invocation
shape, and the native runtime gate executes the result.

```bash
cargo test -p fict-compiler function_valued_state
pnpm test:compiler:native-runtime
pnpm test:compiler:compatibility-corpus
```

## Related decisions

- [ADR-0001 — Adopt an OXC-native Rust compiler](0001-adopt-oxc-rust-compiler.md)
- [Compiler specification](../compiler-spec.md)
- [Compiler migration guide](../migration-guide.md)
