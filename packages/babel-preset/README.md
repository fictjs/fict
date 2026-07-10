# @fictjs/babel-preset

![Node CI](https://github.com/fictjs/fict/workflows/CI/badge.svg)
![npm](https://img.shields.io/npm/v/fict.svg)
![license](https://img.shields.io/npm/l/fict)

Babel preset for Fict - includes TypeScript, JSX, and Fict compiler

## Usage

```bash
npm install fict
npm install -D @fictjs/babel-preset
# or
yarn add fict
yarn add -D @fictjs/babel-preset
```

You can visit [Fict](https://github.com/fictjs/fict) for more documentation.

For standard apps, `fict` is the runtime dependency that pairs with this preset. Direct `@fictjs/runtime` usage remains supported for lower-level integrations, but your source imports should stay on one package family.

## Configuration

`@fictjs/babel-preset` includes:

- `@babel/plugin-transform-typescript` (enabled by default and ordered before Fict)
- `@babel/plugin-syntax-jsx`
- `@fictjs/compiler`

All compiler options are forwarded through this preset.
Fict and TypeScript lowering run in an isolated prepass, so sibling CommonJS or JSX transforms
receive the compiled Fict AST instead of consuming macros or JSX first. Plugins and presets
explicitly configured alongside this preset continue to participate in the outer Babel pipeline.

```js
// babel.config.js
module.exports = {
  presets: [
    [
      '@fictjs/babel-preset',
      {
        // Preset-level options
        typescript: true,
        typescriptOptions: {
          // Optional: force every matched file into one parsing mode.
          // By default .ts/.tsx/.mts/.cts are detected from the filename.
          isTSX: true,
          allExtensions: true,
          allowNamespaces: true,
          allowDeclareFields: true,
          onlyRemoveTypeImports: false,
          optimizeConstEnums: false,
          jsxPragma: 'React.createElement',
          jsxPragmaFrag: 'React.Fragment',
          disallowAmbiguousJSXLike: false,
          rewriteImportExtensions: false,
        },
        // Compiler options (forwarded)
        strictGuarantee: true,
        emitModuleMetadata: 'auto',
      },
    ],
  ],
}
```

Recommended profiles:

```js
// Strict default app/CI profile
module.exports = {
  presets: [['@fictjs/babel-preset', { strictGuarantee: true }]],
}

// Non-production migration / benchmark profile
module.exports = {
  presets: [
    ['@fictjs/babel-preset', { strictGuarantee: false, emitModuleMetadata: false, dev: false }],
  ],
}
```

Key defaults:

- compiler `strictGuarantee`: `true`
- production compilation (`NODE_ENV=production`) force-enables compiler `strictGuarantee`
- compiler `emitModuleMetadata`: `'auto'`
- preset `typescript`: `true`
- preset `typescriptOptions.allExtensions`: `false` (detect from filename)
- preset `typescriptOptions.allowDeclareFields`: `true`

## Cross-file hook metadata

When no explicit `moduleMetadata` or `resolveModuleMetadata` integration is configured, the
preset prepares metadata for local filesystem imports before compiling their importer. Each Babel
transform uses an isolated graph session, so importer-first builds and changed transitive hook
dependencies cannot reuse metadata from an earlier transform. Dependency preparation uses the same
TypeScript/CTS options as the importing transform.

Resource imports with a query stay opaque; URL-fragment imports resolve metadata from their base
module. In strict guarantee mode, an imported hook-like function fails with `FICT-H003` when
current metadata cannot be obtained (for example, an unresolved alias or re-export, an unpublished
package metadata entry, or a module cycle). Configure an explicit metadata store/resolver, publish
package metadata, or use the Vite/Webpack graph integration for those module graphs. Non-strict
migration builds emit the diagnostic as a warning and retain the opaque value behavior.
