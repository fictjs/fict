---
'@fictjs/runtime': patch
---

Stop exposing overlapping delegated-event index signatures on the global DOM `Element` type so strict external TypeScript consumers can check the published declarations with `skipLibCheck` disabled.
