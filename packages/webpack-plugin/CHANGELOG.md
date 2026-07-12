# @fictjs/webpack-plugin

## 0.27.0

### Minor Changes

- Introduce the Webpack 5 plugin and loader for Fict compiler transforms.
  Dependency metadata is prepared before importers, including cold builds and
  circular module graphs.
- Persist local metadata and importer fingerprints in Webpack module build
  information so watch rebuilds and filesystem-cache restores keep unchanged
  importers correct. Cache schema migrations, invalidation, and Node 22 package
  lookup behavior now converge deterministically.
- Resolve published `fict.metadata`/`fict.exports` package metadata through
  canonical exports, legacy package boundaries, and supported renamed CommonJS
  externals. Every consulted manifest and sidecar is tracked as a Webpack
  dependency, while ambiguous aliases, virtual filesystems, and unsupported
  resolver/output configurations fail closed.
- Key metadata by module identity and resource query, follow rewritten metadata
  requests, preserve static ESM and CTS `import = require` edges, and isolate
  variant builds without leaking metadata between modules.
- Preserve supported decorator syntax for a downstream Babel or TypeScript
  loader to lower, and accept CommonJS top-level returns.
- Explicitly reject `resumable: true` and user-provided `publicModuleId`
  because this integration does not yet emit split handler chunks or a
  resumability manifest. Use `@fictjs/vite-plugin` for resumable builds.

### Patch Changes

- Updated dependencies:
  - @fictjs/babel-preset@0.27.0
  - @fictjs/compiler@0.27.0
