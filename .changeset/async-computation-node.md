---
'@fictjs/runtime': minor
'fict': minor
---

Add an explicit async computation node through `createAsyncMemo` in the advanced
entry point. Promise and async iterable values share current/stale/error readiness,
generation protection, cancellation, and root disposal. Ordinary Promise-valued
synchronous memos retain their existing behavior.
