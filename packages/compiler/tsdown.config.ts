import { defineConfig } from 'tsdown'

import { packageOutExtensions } from '../../scripts/tsdown-presets.mjs'

export default defineConfig({
  entry: 'src/index.ts',
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  outExtensions: packageOutExtensions,
  outputOptions: {
    exports: 'named',
  },
  deps: {
    neverBundle: [
      '@babel/core',
      '@babel/helper-plugin-utils',
      '@babel/plugin-transform-destructuring',
      '@babel/traverse',
    ],
    onlyBundle: [/^@babel\/(types|helper-validator-identifier|helper-string-parser)$/],
  },
})
