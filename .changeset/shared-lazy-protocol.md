---
'@fictjs/runtime': minor
'@fictjs/router': minor
'fict': minor
---

Unify framework and router lazy components around preload, reset, retry, and
Suspense semantics, including compatibility with legacy router lazy markers.
Deprecate the router-specific resource helper in favor of `fict/plus` and add
request cancellation to the retained compatibility implementation.
