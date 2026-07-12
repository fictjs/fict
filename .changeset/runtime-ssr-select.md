---
'@fictjs/runtime': patch
---

Select only the first matching option when applying a `select.value` property,
matching browser behavior for duplicate values while allowing server-side DOM
implementations with a read-only select getter to serialize reactive form state.
