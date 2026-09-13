---
'@fictjs/runtime': minor
'fict': minor
---

Compose async computations through synchronous memo, effect, and render consumers.
Preserve committed cleanup while inputs are pending, add `createAsyncEffect` for
pure preparation before effect replacement, and retain graph-owned Suspense views
until their consumers are ready. Preserve arbitrary rejection values and the
existing behavior of ordinary Promise-valued synchronous memos.
