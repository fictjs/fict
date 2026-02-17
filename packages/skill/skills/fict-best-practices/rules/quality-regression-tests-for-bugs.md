---
title: Add Focused Regression Tests for Every Bug Fix
impact: CRITICAL
impactDescription: prevents repeated defects in compiler/runtime hot paths
tags: quality, testing, regression, reliability
---

## Add Focused Regression Tests for Every Bug Fix

Every defect fix should include a minimal failing test that reproduces the
original behavior and asserts the fix. Prefer precise, low-noise tests near the
affected package.

**Incorrect (fix without test):**

```text
Fix merged after manual verification only.
No compiler/runtime test added.
```

**Correct (repro + assertion):**

```ts
import { describe, expect, it } from 'vitest'
import { compile } from '@fictjs/compiler'

describe('regression: computed owner labeling', () => {
  it('does not count object-wrapper computed as user computed', () => {
    const out = compile(`
      function App() {
        let count = $state(0)
        const doubled = count * 2
        return <div>{doubled}</div>
      }
    `)

    expect(out.code).toContain('doubled')
    expect(out.diagnostics).toHaveLength(0)
  })
})
```

Reference: [Strict Guarantee Test Policy](https://github.com/fictjs/fict/blob/main/docs/strict-guarantee-test-policy.md)
