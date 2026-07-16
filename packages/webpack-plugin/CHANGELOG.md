# @fictjs/webpack-plugin

## 1.0.0

### Major Changes

- Remove the legacy TypeScript/Babel compiler stack and make the Rust native compiler mandatory.
  - `@fictjs/compiler` now exposes only the Rust request API; `./legacy` and `createFictPlugin` are removed.
  - `@fictjs/vite-plugin` no longer accepts legacy or shadow backend selection and always uses the native compiler.
  - `@fictjs/webpack-plugin` no longer provides the Babel preset/legacy loader path and requires the native compiler.
  - `@fictjs/babel-preset` is retired; `0.30.1` remains the final legacy-compatible release and rollback target.

  Follow `docs/migration-guide.md` before upgrading. Native compiler installation failures now fail closed instead of falling back to Babel.

### Patch Changes

- Updated dependencies
  - @fictjs/compiler@1.0.0

## 0.28.3

### Patch Changes

- @fictjs/compiler@0.30.1

## 0.28.2

### Patch Changes

- Updated dependencies [901347c]
  - @fictjs/compiler@0.30.0

## 0.28.1

### Patch Changes

- Updated dependencies [192cf64]
- Updated dependencies [192cf64]
- Updated dependencies [192cf64]
- Updated dependencies [192cf64]
- Updated dependencies [192cf64]
- Updated dependencies [192cf64]
- Updated dependencies [192cf64]
- Updated dependencies [192cf64]
- Updated dependencies [192cf64]
- Updated dependencies [192cf64]
- Updated dependencies [c8ab75e]
- Updated dependencies [192cf64]
- Updated dependencies [192cf64]
- Updated dependencies [192cf64]
- Updated dependencies [192cf64]
- Updated dependencies [192cf64]
- Updated dependencies [192cf64]
- Updated dependencies [192cf64]
  - @fictjs/compiler@0.29.0

## 0.28.0

### Minor Changes

- Accept Babel's valid empty-string transform result for empty source modules.
  Empty Webpack entries now compile successfully instead of being reported as
  missing compiler output.

### Patch Changes

- Updated dependencies
- Updated dependencies [1d8200a]
  - @fictjs/babel-preset@0.28.0
  - @fictjs/compiler@0.28.0

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
