const path = require('path')
const HtmlWebpackPlugin = require('html-webpack-plugin')
const { createFictPlugin } = require('@fictjs/compiler')

module.exports = {
  entry: './src/main.tsx',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'bundle.js',
    clean: true,
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js', '.jsx'],
  },
  module: {
    rules: [
      {
        test: /\.(tsx|jsx)$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: [['@babel/preset-typescript', { isTSX: true, allExtensions: true }]],
            plugins: [
              ['@babel/plugin-syntax-jsx', {}],
              [createFictPlugin, {}],
            ],
          },
        },
      },
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: ['@babel/preset-typescript'],
          },
        },
      },
    ],
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: './index.html',
    }),
  ],
  devServer: {
    static: {
      directory: path.join(__dirname, 'dist'),
    },
    port: 3000,
    hot: true,
    open: true,
  },
}
