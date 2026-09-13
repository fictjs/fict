---
'@fictjs/compiler': patch
---

Recognize official selector sources and runtime callback aliases by intact import
identity. Preserve checks for unowned async continuations, reactive equality
captures, replaced methods, and external functions with runtime API names.
