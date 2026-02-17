---
title: Treat Fallback Diagnostics as Blocking
impact: CRITICAL
impactDescription: avoids silent downgrade from guaranteed semantics to fallback paths
tags: compiler, diagnostics, reliability, review
---

## Treat Fallback Diagnostics as Blocking

Do not silence or normalize fallback diagnostics (`FICT-P*`, `FICT-R*`,
`FICT-J*`, `FICT-S002`) when working in strict guarantee paths. Rewrite code
into analyzable shapes instead of downgrading correctness policy.

**Incorrect (accepts fallback shapes):**

```tsx
function Panel(props: Record<string, unknown>, key: string) {
  const { [key]: value } = props // dynamic destructuring can trigger fallback
  return <div>{String(value)}</div>
}
```

```ts
// build config (unsafe default for app code)
strictGuarantee: false
```

**Correct (rewrite to guaranteed form):**

```tsx
function Panel(props: { title?: string }) {
  const title = props.title
  return <div>{title}</div>
}
```

```ts
// keep strict guarantee and fix diagnostics at source
strictGuarantee: true
```

Reference: [Diagnostic Codes](https://github.com/fictjs/fict/blob/main/docs/diagnostic-codes.md)
