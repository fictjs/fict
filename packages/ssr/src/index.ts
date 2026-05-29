// Public SSR API (Satellite tier — see SCOPE.md).
//
// Preview APIs (no semver guarantee) are NOT exported here. They live in
// `@fictjs/ssr/experimental` (see ./experimental and docs/PREVIEW.md).
//
// The implementation lives in ./render-core (an internal module not listed in
// package.json#exports); this file is a thin surface that controls exactly
// which symbols are part of the supported, externally importable API.

export {
  createSSRDocument,
  renderToDocument,
  renderToString,
  renderToStringAsync,
  renderToStream,
  renderToPipeableStream,
} from './render-core'

export type {
  SSRDom,
  RenderToStringOptions,
  RenderToStreamOptions,
  PipeableStream,
  RenderToDocumentResult,
} from './render-core'
