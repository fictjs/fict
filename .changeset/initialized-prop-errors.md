---
'@fictjs/runtime': patch
---

Preserve async rejection identity during initialized JSX call props. Rejections
whose values are pending tokens still throw and reach the caller's error handler;
only genuine pending reads defer to the prop's eventual consumer.
