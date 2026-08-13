---
'@fictjs/router': minor
---

Make Link and NavLink prefetch matched route data and lazy components instead
of emitting an unhandled custom event. Prefetching now respects router bases,
navigation state, external and document-reload links, and retry behavior.
