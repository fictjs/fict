---
'@fictjs/runtime': patch
---

Store prepared binding values directly in the managed effect owner, removing two
forwarding closures per binding while retaining async preparation, cleanup and
error semantics. Current strict benchmark measurements show lower allocation and
live page memory; repeated CPU results do not establish a stable overall speedup.
