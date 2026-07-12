---
'fict': patch
'@fictjs/runtime': patch
'@fictjs/compiler': patch
'@fictjs/babel-preset': patch
'@fictjs/vite-plugin': patch
'@fictjs/ssr': patch
---

Make resumability and partial prerendering explicitly Preview and non-blocking
for Core 1.0. This is a breaking Preview change: import the resumable loader
from `fict/experimental/loader` or `@fictjs/runtime/experimental/loader` instead
of the former `/loader` subpaths, and set `includeSnapshot: true` because
supported SSR no longer emits the Preview snapshot protocol by default.

The repository now release-gates a machine-readable maturity registry against
the Core fixed group, experimental entrypoints, default-off opt-ins, and
`@experimental` type documentation. The boundary scanner also recognizes
escaped module specifiers in regular expressions and configuration aliases.
