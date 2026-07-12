# @fictjs/vscode-extension

## 0.21.1

### Patch Changes

- Package Marketplace-valid VSIX archives with all runtime dependencies bundled
  and verify the final extension manifest.
- Lower TypeScript-only compile-preview sources before Fict tooling analysis,
  matching the supported compiler integration order.
- Upgrade the bundled Babel and WebSocket dependencies to patched releases.

## 0.21.0

### Minor Changes

- Publish the extension against compiler 0.21 so analyzer and preview integrations consume the current compiler metadata.

### Patch Changes

- Updated dependencies
  - @fictjs/compiler@0.21.0

## 0.20.0

### Minor Changes

- Publish the extension against compiler 0.20 so analyzer integrations consume the current diagnostics and metadata surfaces.

### Patch Changes

- Updated dependencies
  - @fictjs/compiler@0.20.0

## 0.19.0

### Minor Changes

- Publish the extension with the package metadata release train so analyzer integrations stay compatible with current compiler output.

### Patch Changes

- Updated dependencies
  - @fictjs/compiler@0.19.0

## 0.18.0

### Minor Changes

- Preserve compiler diagnostic locations, structured fallback errors, and strict-guarantee behavior in analyzer and compile preview output.

### Patch Changes

- Updated dependencies
  - @fictjs/compiler@0.18.0

## 0.17.1

### Patch Changes

- Updated dependencies
  - @fictjs/compiler@0.17.1

## 0.17.0

### Minor Changes

- Keep analyzer and preview integrations compatible with resumable handler compiler output.

### Patch Changes

- Updated dependencies
  - @fictjs/compiler@0.17.0

## 0.2.0

### Minor Changes

- Publish the extension against compiler 0.16 so analyzer integrations consume map-key diagnostics and tooling analysis APIs.

### Patch Changes

- Updated dependencies
  - @fictjs/compiler@0.16.0
