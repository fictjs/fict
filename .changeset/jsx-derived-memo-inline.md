---
'@fictjs/compiler': patch
---

Inline implicit scalar memos with one intrinsic JSX text consumer, including
generated namespace alternatives. The source proof checks component ownership,
initialization order and every state write. Explicit memos, shared or escaped
values, custom component props, unknown inputs and potentially observable
coercions retain their materialized computations.
