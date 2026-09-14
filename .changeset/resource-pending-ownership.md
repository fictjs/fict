---
'@fictjs/runtime': patch
'fict': patch
---

Cancel no-cache resource work when its final reader, prefetch or suspended replay
owner leaves. Keep shared requests alive for other readers and retain resolved
values across legacy Suspense retries without leaking abandoned initial requests.
