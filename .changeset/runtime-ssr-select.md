---
'@fictjs/runtime': patch
---

Apply `select.value` with native first-match and DOM string semantics, including
when duplicate or multiple selection state was externally mutated without
changing the cached textual value. Server-side DOM implementations with a
read-only select getter can still serialize reactive form state consistently.
