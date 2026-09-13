---
'@fictjs/runtime': minor
'fict': minor
---

Use the shared async graph readiness and generation protocol for Resource entries.
Reactive data consumers now compose through synchronous and async derived nodes
and retained Suspense owners. Cache, TTL, SWR, sharing, optimistic updates and the
legacy setup-read behavior are preserved. Lazy shared field projections retain
data/loading/error notification precision, including first reads during cleanup
and readers retained after cache eviction.
