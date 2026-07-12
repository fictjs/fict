---
'@fictjs/ssr': patch
---

Harden SSR security boundaries. Legacy `exposeGlobals` installations now
restore exact descriptors transactionally and reject nested or overlapping
renders. External-runtime shell streams also reject nonce-free Preview
snapshots targeted at `head`, where incremental placement would otherwise require
an executable inline mover.
