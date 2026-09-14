---
'@fictjs/compiler': patch
'@fictjs/runtime': patch
---

Initialize and cache component call props so multiple consumers share one value
and object/function identity. Preserve unread prop evaluation, call order and
ordinary exceptions while retaining opaque helper dependencies and allowing
unavailable async graph values to suspend their rendering consumers.
