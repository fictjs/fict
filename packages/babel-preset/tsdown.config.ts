import { defineConfig } from 'tsdown'

import { packageOutExtensions } from '../../scripts/tsdown-presets.mjs'

export default defineConfig({
  entry: 'src/index.ts',
  format: ['cjs', 'esm'],
  dts: {
    compilerOptions: {
      rootDir: undefined,
      composite: false,
      skipLibCheck: true,
    },
  },
  clean: true,
  outExtensions: packageOutExtensions,
  outputOptions: {
    exports: 'named',
  },
  deps: {
    neverBundle: [
      '@babel/core',
      '@babel/preset-typescript',
      '@babel/plugin-syntax-jsx',
      '@fictjs/compiler',
    ],
  },
})
