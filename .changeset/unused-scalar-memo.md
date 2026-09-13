---
'@fictjs/compiler': patch
---

Remove unused implicit memos when closed local state and expression analysis prove
total scalar evaluation. Preserve explicit memos, unknown effects/coercions and
existing optimizer policies. Graph explanations distinguish elimination from
inlining, and core counters separate analyzed SSA candidates from actual rewrites.
