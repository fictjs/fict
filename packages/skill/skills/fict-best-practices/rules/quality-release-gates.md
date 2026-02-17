---
title: Run Compiler and Runtime Release Gates Before Merge
impact: CRITICAL
impactDescription: catches correctness and performance regressions before shipping
tags: quality, release, ci, performance
---

## Run Compiler and Runtime Release Gates Before Merge

Use reproducible gate commands before merging compiler/runtime changes. A patch
is not release-ready until tests, type checks, strict diagnostics, and
performance guards all pass.

**Incorrect (partial verification):**

```bash
pnpm --filter @fictjs/compiler test
```

**Correct (full gate sequence):**

```bash
pnpm release:compiler:verify
pnpm --dir packages/runtime test
pnpm stress:runtime
pnpm bench:optimizer:guard
```

Reference: [Repository scripts](https://github.com/fictjs/fict/blob/main/package.json)
