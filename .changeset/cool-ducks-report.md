---
'@fictjs/compiler': patch
---

Return an explicit `null` native compiler revision for uncontrolled local builds
so the JavaScript loader accepts the documented local N-API metadata contract.
