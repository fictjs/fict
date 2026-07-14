import { defineConfig } from 'tsdown'

import { packageOutExtensions } from '../../scripts/tsdown-presets.mjs'

export default defineConfig({
  entry: {
    'graph-host': 'src/graph-host.ts',
    index: 'src/index.ts',
    legacy: 'src/legacy.ts',
    'native-loader': 'src/native-loader.ts',
  },
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
