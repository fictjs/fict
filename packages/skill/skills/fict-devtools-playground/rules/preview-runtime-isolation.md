---
title: Keep Playground Runtime and Production Runtime Isolated
impact: HIGH
impactDescription: protects production runtime from playground-specific complexity
tags: playground, runtime, architecture, isolation
---

## Keep Playground Runtime and Production Runtime Isolated

Playground helpers should stay behind explicit adapters. Do not mix playground
session logic into core runtime package entry points.

**Incorrect (runtime imports playground helpers):**

```ts
// packages/runtime/src/index.ts
import { setupPreviewMessaging } from '@fictjs/playground'
setupPreviewMessaging()
```

**Correct (playground imports runtime, not reverse):**

```ts
// packages/playground/src/preview-runtime.ts
import { render } from 'fict'

export function bootPreview(view: () => unknown, mount: HTMLElement) {
  render(view as never, mount)
}
```

Reference: [Fict architecture](https://github.com/fictjs/fict/blob/main/docs/architecture.md)
