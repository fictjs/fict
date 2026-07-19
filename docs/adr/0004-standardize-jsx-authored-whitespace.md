---
type: adr
title: ADR-0004 — Standardize authored JSX whitespace
description: Keep the native compiler's standard JSX multiline text normalization and document the Babel 0.28 migration boundary.
owner: unadlib
status: accepted
risk_level: medium
tags: [compiler, jsx, compatibility, migration]
---

# ADR-0004 — Standardize authored JSX whitespace

## Context

Babel compiler 0.28 preserved the raw line terminators and indentation of JSX
text nodes. The OXC-native compiler applies the conventional JSX authored-text
rule: it trims indentation around line breaks, removes formatting-only lines,
and joins remaining non-empty lines with one space. The difference is visible
in elements such as `<pre>` and cannot be recovered later with CSS.

This is a source-language compatibility decision, not an emitter formatting
difference. Reverting the native compiler would preserve an accidental legacy
behavior while making Fict JSX disagree with the established JSX source model.

## Decision

The native behavior is the Fict 0.31 contract. Multiline authored JSX text is
normalized before template, VNode, DOM, or SSR lowering. Element names do not
opt out, including `<pre>`, raw-text, and RCDATA elements.

Whitespace that is application data MUST be authored as an expression string:

```tsx
<pre>{'first\n  second'}</pre>
```

Same-line authored spaces, non-breaking spaces, and explicit `{' '}`
expressions remain data and are preserved. Fict does not provide a
legacy-whitespace compiler option.

The Babel 0.28 result remains a reviewed migration deviation. Runtime
compatibility gates MUST identify it by this decision rather than silently
adding the two text snapshots to a generic allowlist.

## Options considered

### Restore Babel 0.28 raw whitespace

Rejected. It would make indentation part of rendered data contrary to normal
JSX authoring expectations and would preserve different text semantics solely
because of the retired frontend.

### Add a legacy compiler switch

Rejected. A source-level mode would make identical JSX files render
differently across builds and extend a migration-only behavior indefinitely.

### Normalize only outside `<pre>`

Rejected. JSX source normalization happens before HTML element semantics.
`<pre>` controls how retained characters render; it does not redefine which
characters a JSX text token contains.

## Consequences

- Multiline prose generally becomes stable across indentation changes.
- Applications relying on Babel 0.28 indentation must move exact text into an
  expression string.
- Snapshots and `<pre>` content require migration review.
- DOM and SSR lowering consume one normalized value and cannot drift on this
  rule independently.

## Verification

The compiler frontend tests cover multiline, formatting-only, same-line,
non-breaking, and explicit-expression whitespace. The native runtime test and
compatibility deviation registry must retain the rendered Babel and native
snapshots for the migration-sensitive `<pre>` case.

```bash
cargo test -p fict-compiler-oxc jsx_text
pnpm test:compiler:native-runtime
pnpm test:compiler:compatibility-corpus
```

## Related decisions

- [ADR-0001 — Adopt an OXC-native Rust compiler](0001-adopt-oxc-rust-compiler.md)
- [Compiler specification](../compiler-spec.md#authored-jsx-text-whitespace)
- [Compiler migration guide](../migration-guide.md#jsx-authored-text-whitespace)
