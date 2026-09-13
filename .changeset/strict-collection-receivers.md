---
'@fictjs/compiler': patch
---

Preserve direct array type contracts and certified immutable aliases through
shallow-copy and dynamic-index analysis. Accept scalar search results in built-in
index/count positions while retaining nested-mutation, method-replacement, and
unknown-call escape boundaries.
