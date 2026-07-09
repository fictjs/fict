---
'@fictjs/testing-library': patch
---

Publish condition-specific CommonJS declarations so TypeScript Node16/NodeNext
consumers resolve the testing library through `require.types` and the generated
`.d.cts` output. No testing utility runtime or API behavior changed.
