---
title: Gate Devtools Bridge to Development Paths
impact: CRITICAL
impactDescription: avoids production runtime overhead and attack surface
tags: devtools, build, performance, security
---

## Gate Devtools Bridge to Development Paths

Only inject devtools bridge code in development serve workflows. Avoid loading
bridge runtime in production bundles.

**Incorrect (bridge always enabled):**

```ts
import 'virtual:fict-devtools'
```

**Correct (conditional dev-only injection):**

```ts
if (import.meta.env.DEV) {
  await import('virtual:fict-devtools')
}
```

Reference: [@fictjs/devtools README](https://github.com/fictjs/fict/blob/main/packages/devtools/README.md)
