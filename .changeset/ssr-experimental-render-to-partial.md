---
'@fictjs/ssr': minor
---

Move the Preview `renderToPartial` API off the `@fictjs/ssr` main export to a
dedicated `@fictjs/ssr/experimental` entrypoint.

- Import it from `@fictjs/ssr/experimental` instead of `@fictjs/ssr`.
- The supported surface — `renderToString`, `renderToStringAsync`,
  `renderToStream`, `renderToPipeableStream`, `renderToDocument`,
  `createSSRDocument` — is unchanged.

This aligns SSR with the Preview policy (`docs/PREVIEW.md`): Preview APIs are
reachable only via an `experimental` entrypoint, never a package's main export.
The implementation moved to an internal `render-core` module that is not part of
`package.json#exports`.
