# @fictjs/webpack-plugin

Webpack 5 integration for the Fict compiler. The plugin and loader cooperate so local hook
metadata is available before importers receive their final transform, including cold builds and
circular module graphs.

```js
const { FictWebpackPlugin } = require('@fictjs/webpack-plugin')

module.exports = {
  module: {
    rules: [
      {
        test: /\.[cm]?[jt]sx?$/,
        exclude: /node_modules/,
        use: [{ loader: require.resolve('@fictjs/webpack-plugin/loader') }],
      },
    ],
  },
  plugins: [new FictWebpackPlugin()],
}
```

If another Babel transform is needed, place its loader to the left of the Fict loader so it runs
after Fict compilation. Do not also configure `@fictjs/babel-preset` in that Babel loader.

Local reactive metadata and importer dependency fingerprints are persisted in Webpack module build
information, so watch rebuilds and filesystem-cache restores keep unchanged importers correct.
Bare package imports can consume published `fict.metadata` / `fict.exports` declarations; every
consulted package manifest and metadata sidecar is registered as a Webpack dependency and included
in the importer fingerprint. See [Third-party library metadata](../../docs/third-party-libraries.md).
For legacy packages without `exports`, entry proof follows Webpack's effective `mainFields`,
`mainFiles`, and `extensions` order and accepts only a uniquely matched file contained by the
package. Active package `aliasFields`, directory targets, and ambiguous public spellings fail
closed when Fict metadata is declared. Active `extensionAlias`, non-default `exportsFields`, custom
description manifests, and malformed export maps also fail closed because they cannot be proven as
the documented package contract; publishing a canonical `package.json` `exports` map is recommended.
Package metadata paths must currently be readable through Node's filesystem APIs. Yarn PnP zip
archives and other virtual filesystems are not yet supported by this integration.
Webpack library metadata publishing remains a separate capability.
