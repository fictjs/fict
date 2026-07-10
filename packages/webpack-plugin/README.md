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

This initial integration coordinates metadata within one cold Webpack compilation. Incremental
watch/cache persistence and Webpack library metadata publishing are separate capabilities.
