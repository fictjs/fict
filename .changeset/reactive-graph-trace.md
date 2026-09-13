---
'@fictjs/compiler': patch
---

Add an opt-in reactive graph trace to native explanation output. Correlate source
bindings and verified EmitIR plans with actual memo inline decisions and final
main-module helper call sites, with explicit static-count and ownership boundaries.
