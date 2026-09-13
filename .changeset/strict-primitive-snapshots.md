---
'@fictjs/compiler': patch
---

Accept explicit `untrack` snapshots of proven component-local primitive state under
strict guarantees. Preserve diagnostics for mutable values, retained reactive
callbacks, asynchronous work, and unrelated or shadowed functions named `untrack`.
