---
'@fictjs/ssr': patch
---

Harden SSR security boundaries. Legacy `exposeGlobals` installations now
restore exact descriptors transactionally and run exclusively from every other
SSR render. External-runtime shell streams also reject nonce-free Preview
snapshots targeted at `head`, where incremental placement would otherwise require
an executable inline mover. Ordinary render-local SSR remains available when a
hardened host makes its process global object non-extensible; exposed-global
compatibility mode continues to fail closed in that environment.
