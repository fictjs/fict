---
'@fictjs/runtime': patch
---

Resume consumers when an async-dependent memo becomes readable again, even when
its result equals its previous successful value. This fixes stale conditional
content after a Resource key change while preserving ordinary memo equality.
