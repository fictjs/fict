---
'@fictjs/compiler': minor
'@fictjs/runtime': minor
'fict': minor
---

Compile explicit `$async` declarations into owned async graph computations with
resolved-value types, generation cancellation, and reactive consumers. Preserve
manual `createAsyncMemo` calls, methods, immutable aliases, and callable resolved
values through direct and structured cross-module metadata.

Synchronous producer captures have an explicit strict contract. Native async
continuations, unsupported nested async construction, writes, and Preview
resumability receive diagnostics. Ordinary Promise-valued memos keep their
existing semantics. Publishers and consumers need matching compiler/runtime and
metadata support for the new `async` and `asyncAccessor` kinds.
