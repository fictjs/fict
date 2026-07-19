---
type: adr
title: ADR-0006 — Materialize JSX values before raw-text coercion
description: Preserve Babel 0.28 raw-text and RCDATA stringification by coercing the DOM representation of renderable JSX values.
owner: unadlib
status: accepted
risk_level: medium
tags: [compiler, runtime, jsx, compatibility, dom]
---

# ADR-0006 — Materialize JSX values before raw-text coercion

## Context

HTML raw-text and RCDATA elements cannot contain child element nodes. Fict
therefore binds dynamic children of `<script>`, `<style>`, `<textarea>`, and
`<title>` through `textContent`.

When such an expression evaluates to JSX, Babel compiler 0.28 had already
materialized the JSX as a DOM node before JavaScript string coercion. For
example, `<script>{<span />}</script>` produced
`[object HTMLSpanElement]`. The native compiler passes a VNode to the same
binding, which previously exposed the implementation representation as
`[object Object]`.

Neither value is nested markup, but changing it silently breaks released
observable behavior and leaks whether the active compiler uses eager DOM nodes
or VNodes.

## Decision

Raw-text and RCDATA bindings retain Babel 0.28 value coercion. Before calling
`String`, the runtime materializes a Fict VNode through the registered DOM
creator. Arrays recursively materialize their VNode entries and then retain
normal JavaScript array stringification. Existing DOM nodes, primitives, and
ordinary objects keep ordinary string coercion; `null`, `undefined`, and
booleans remain empty text.

The materialized node is used only as the value being coerced. It is not
inserted into the raw-text element. Any component setup performed while
materializing stays owned by the surrounding render root and is disposed with
that root, matching the legacy execution boundary.

## Options considered

### Keep VNode object stringification as a reviewed deviation

Rejected. The difference reveals an internal representation and can be removed
at the runtime boundary without changing valid raw-text markup behavior.

### Serialize the JSX as markup text

Rejected. Babel 0.28 did not serialize markup, and doing so would introduce
escaping and script/style security questions unrelated to ordinary value
coercion.

### Reject JSX-valued raw-text expressions

Rejected for the compatibility release. It is a defensible future type or
lint rule, but turning released successful input into a compiler error is a
larger API decision than preserving its existing runtime value.

## Consequences

- Raw-text and RCDATA values no longer expose compiler representation choice.
- The audited intrinsic JSX case again produces
  `[object HTMLSpanElement]` on both compilers.
- Component-valued expressions execute component setup as they did under the
  legacy eager-DOM compiler, even though their node is not inserted.
- The runtime must keep VNode detection narrow so ordinary objects continue to
  stringify normally.

## Verification

Runtime unit tests distinguish VNodes, ordinary objects, primitives, and DOM
nodes. The native compiler runtime gate asserts initial and updated
`textContent` for child expressions and the `children` prop form.

```bash
pnpm --dir packages/runtime test -- binding-edge-cases.test.ts
pnpm test:compiler:native-runtime
```

## Related decisions

- [ADR-0001 — Adopt an OXC-native Rust compiler](0001-adopt-oxc-rust-compiler.md)
- [ADR-0004 — Standardize authored JSX whitespace](0004-standardize-jsx-authored-whitespace.md)
- [Compiler specification](../compiler-spec.md)
