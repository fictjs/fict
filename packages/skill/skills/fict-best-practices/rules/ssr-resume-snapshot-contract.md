---
title: Preserve Snapshot Schema and Loader Failure Semantics
impact: HIGH
impactDescription: protects resumability across deploys and mixed-version clients
tags: ssr, resume, snapshot, compatibility
---

## Preserve Snapshot Schema and Loader Failure Semantics

Treat SSR snapshot payloads as versioned contracts. Keep `v` and `scopes` shape
compatible with `FICT_SSR_SNAPSHOT_SCHEMA_VERSION`, and wire loader issues to
telemetry using `onSnapshotIssue`.

**Incorrect (non-versioned custom snapshot payload):**

```html
<script id="__FICT_SNAPSHOT__" type="application/json">
  { "state": { "foo": 1 } }
</script>
```

```ts
import { installResumableLoader } from '@fictjs/runtime/loader'

installResumableLoader()
```

**Correct (contract-compliant payload + issue reporting):**

```html
<script id="__FICT_SNAPSHOT__" type="application/json">
  { "v": 1, "scopes": { "s1": { "id": "s1", "slots": [[0, "sig", 1]] } } }
</script>
```

```ts
import { installResumableLoader } from '@fictjs/runtime/loader'

installResumableLoader({
  onSnapshotIssue(issue) {
    console.error('[resume-issue]', issue.code, issue.message)
  },
})
```

Reference: [SSR Resume Stability Contract](https://github.com/fictjs/fict/blob/main/docs/ssr-resume-stability-contract.md)
