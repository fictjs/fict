---
title: Keep Standalone and Extension Behavior in Parity
impact: CRITICAL
impactDescription: prevents environment-specific regressions after release
tags: quality, devtools, extension, standalone
---

## Keep Standalone and Extension Behavior in Parity

Any feature added to standalone mode should be checked in extension mode (and
vice versa) against the same acceptance criteria.

**Incorrect (validate only standalone):**

```text
Tested at /__fict-devtools__/ only.
Extension scenario not checked.
```

**Correct (dual-mode parity checks):**

```text
Validate both modes:
1. standalone /__fict-devtools__/
2. extension panel

Ensure parity for:
- handshake/connect
- inspector data
- graph/timeline navigation
- error handling behavior
```

Reference: [@fictjs/devtools README](https://github.com/fictjs/fict/blob/main/packages/devtools/README.md)
