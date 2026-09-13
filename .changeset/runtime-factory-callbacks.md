---
'@fictjs/compiler': patch
---

Recognize intact local Resource read methods and transition handles by their
factory identities. Explicitly marked Resource getters retain strict guarantees,
and Resource read results and derived transition-pending labels stay reactive in
both DOM backends. Verified HIR facts preserve manual accessor identity and avoid
memoizing stable extracted methods. Ordinary function arguments retain their data
semantics; mutable container escapes, overwritten or unknown hosts, and async
continuations keep their boundaries.
