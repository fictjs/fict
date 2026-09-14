---
'@fictjs/runtime': patch
---

Let effects and derived getters execute their current branches and local exception
handlers instead of pre-reading old async dependencies or caching upstream failures
on unexecuted getters. Keyed lists prepare their current source before committing
DOM changes. Ordinary effects clean up before each attempt; use
`createAsyncEffect(prepare, commit)` to retain committed work during pending inputs.
