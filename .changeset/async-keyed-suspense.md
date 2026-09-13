---
'@fictjs/runtime': patch
---

Keep keyed lists subscribed while Suspense parks their DOM. Initial loads and
refreshes now resume with current rows, preserve surviving row identity, and
continue to ignore superseded results after disposal.
