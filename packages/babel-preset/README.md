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
          isTSX: true,
          allExtensions: true,
          allowNamespaces: true,
          allowDeclareFields: true,
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
- preset `typescriptOptions.allowDeclareFields`: `true`
