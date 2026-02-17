---
title: Validate Changes in examples/counter-basic End-to-End
impact: CRITICAL
impactDescription: catches integration bugs missed by isolated tests
tags: quality, e2e, devtools, playground
---

## Validate Changes in examples/counter-basic End-to-End

For devtools/playground changes, run the real example app and verify data flow,
navigation, graph rendering, and timeline interactions in browser.

**Incorrect (unit tests only):**

```bash
pnpm --filter @fictjs/devtools test
```

**Correct (example-driven validation):**

```bash
pnpm --dir examples/counter-basic dev
# Open app page and devtools page, verify:
# - signals/computed/effects lists
# - graph rendering for all node types
# - click-to-jump navigation
```

Reference: [examples/counter-basic](https://github.com/fictjs/fict/blob/main/examples/counter-basic/)
