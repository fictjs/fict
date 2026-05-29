// `@fictjs/ssr/experimental` — Preview SSR APIs.
//
// NO SEMVER GUARANTEE. APIs here may change shape or be removed in any release,
// including patch releases. See docs/PREVIEW.md (policy + required degradation
// contract) and SCOPE.md (tiers). Reach these only through the explicit
// `@fictjs/ssr/experimental` entrypoint, never the package main export.

export { renderToPartial } from './render-core'
export type { PartialPrerenderResult } from './render-core'
