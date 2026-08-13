---
'@fictjs/router': minor
---

Expose query loading, error, status, and latest-value state. Reading a rejected
query now throws its original rejection so route ErrorBoundaries can handle it,
while successful `undefined` results remain distinguishable from failures.
