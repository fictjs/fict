---
'@fictjs/runtime': minor
'fict': minor
---

Track transition readiness through signal updates, queued computations, and async
graph generations, including indirectly started Resource requests. Preserve both
causes of concurrent input updates, release superseded writes and generations,
and keep unrelated work out of pending state. Shared Resource requests use reader
readiness leases so navigation or disposal does not cancel useful cached work.
Returned Promise support remains compatible; native await/timer continuations
still require explicit registration for later updates.
