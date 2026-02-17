---
title: Keep DevTools Instrumentation Development-Only
impact: MEDIUM
impactDescription: preserves production runtime and bundle characteristics
tags: tooling, devtools, performance, build
---

## Keep DevTools Instrumentation Development-Only

Enable devtools only in development workflows. Keep production builds free of
debugging hooks and standalone panel routes.

**Incorrect (always-on devtools plugin):**

```ts
import { defineConfig } from 'vite'
import fict from '@fictjs/vite-plugin'
import { fictDevTools } from '@fictjs/devtools'

export default defineConfig({
  plugins: [fict(), fictDevTools()],
})
```

**Correct (serve-only devtools plugin):**

```ts
import { defineConfig } from 'vite'
import fict from '@fictjs/vite-plugin'
import { fictDevTools } from '@fictjs/devtools'

export default defineConfig(({ command }) => ({
  plugins: [fict(), command === 'serve' ? fictDevTools() : undefined].filter(Boolean),
}))
```

Reference: [@fictjs/devtools README](https://github.com/fictjs/fict/blob/main/packages/devtools/README.md)
