---
'@fictjs/compiler': minor
'@fictjs/runtime': minor
'fict': minor
---

Add `useContextAccessor` and keep Provider value updates fine-grained without
silently freezing existing `useContext` consumers. Accessor/effect consumers
retain descendant state and DOM identity, while setup-time snapshots keep their
legacy update behavior through compatibility replay.
