---
'@fictjs/ssr': patch
---

Fix pipeable SSR streams so downstream writable errors abort the render instead
of hanging `allReady`.

When a piped Node writable fails after the shell has flushed, Fict now routes the
sink error into the render abort path, releases pending backpressure waits, runs
cleanup, and rejects readiness promises deterministically.
