import { defineConfig } from 'tsdown'

import { packageOutExtensions } from '../../scripts/tsdown-presets.mjs'

export default defineConfig({
  entry: 'src/index.ts',
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  outExtensions: packageOutExtensions,
  outputOptions: {
    exports: 'named',
  },
  deps: {
    neverBundle: [
      '@babel/core',
      '@babel/generator',
      '@babel/parser',
      '@babel/plugin-syntax-jsx',
      '@babel/plugin-transform-react-jsx',
      '@babel/preset-typescript',
      '@babel/traverse',
      '@babel/types',
      '@fictjs/compiler',
      'typescript',
      'vite',
    ],
  },
})
