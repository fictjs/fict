---
title: Preserve Preview Refresh Fidelity on Source Changes
impact: HIGH
impactDescription: avoids stale preview and misleading DX
tags: playground, preview, hmr, refresh
---

## Preserve Preview Refresh Fidelity on Source Changes

When source files change, preview should either apply HMR updates or execute a
reliable full reload fallback. Never keep stale rendered output silently.

**Incorrect (file changes do not propagate):**

```ts
watchSourceFiles(() => {
  // update state only
  setEditorDirty(true)
})
```

**Correct (HMR first, full reload fallback):**

```ts
watchSourceFiles(async changed => {
  const handled = await tryHotUpdate(changed)
  if (!handled) {
    reloadPreviewFrame({ reason: 'hmr-fallback' })
  }
})
```

Reference: [@fictjs/playground README](https://github.com/fictjs/fict/blob/main/packages/playground/README.md)
