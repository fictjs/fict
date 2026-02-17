---
title: Isolate Playground Features from Runtime Core
impact: MEDIUM
impactDescription: prevents product tooling from regressing framework runtime path
tags: tooling, playground, runtime, architecture
---

## Isolate Playground Features from Runtime Core

Keep playground-only behavior in `@fictjs/playground` and integration adapters.
Do not import playground modules into runtime/compiler execution paths.

**Incorrect (runtime depends on playground code):**

```ts
// packages/runtime/src/index.ts
import { startPlaygroundSession } from '@fictjs/playground'

export function bootRuntime() {
  startPlaygroundSession()
}
```

**Correct (optional integration boundary):**

```ts
// packages/playground/src/runtime-adapter.ts
import { render } from 'fict'

export function mountPreview(view: () => unknown, el: HTMLElement) {
  render(view as never, el)
}
```

```ts
// packages/runtime/src/index.ts
export * from './public-runtime-api'
```

Reference: [Fict Architecture](https://github.com/fictjs/fict/blob/main/docs/architecture.md)
