---
title: Enforce Strict Guarantee Mode in CI
impact: CRITICAL
impactDescription: blocks fallback patterns from shipping
tags: compiler, ci, strict-guarantee, diagnostics
---

## Enforce Strict Guarantee Mode in CI

Always run production build pipelines with strict guarantee enforcement. In Fict,
`FICT_STRICT_GUARANTEE=1` forces compiler `strictGuarantee` globally and blocks
known fallback diagnostics that weaken the guarantee contract.

**Incorrect (CI allows guarantee downgrades):**

```bash
pnpm build
```

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import fict from '@fictjs/vite-plugin'

export default defineConfig({
  plugins: [fict({ strictGuarantee: false })],
})
```

**Correct (CI fail-closed):**

```bash
FICT_STRICT_GUARANTEE=1 pnpm build
```

```bash
FICT_STRICT_GUARANTEE=1 pnpm release:compiler:verify
```

Reference: [Reactivity Guarantee Matrix](https://github.com/fictjs/fict/blob/main/docs/reactivity-guarantee-matrix.md)
