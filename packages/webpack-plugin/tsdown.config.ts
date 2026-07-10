import { defineConfig } from 'tsdown'

import { packageOutExtensions } from '../../scripts/tsdown-presets.mjs'

export default defineConfig({
  entry: ['src/index.ts', 'src/loader.ts'],
  format: ['cjs', 'esm'],
  dts: {
    compilerOptions: {
      rootDir: undefined,
      composite: false,
      skipLibCheck: true,
    },
  },
  clean: true,
  sourcemap: true,
  outExtensions: packageOutExtensions,
  outputOptions: {
    exports: 'named',
  },
  deps: {
    neverBundle: ['@babel/core', '@fictjs/babel-preset', '@fictjs/compiler', 'webpack'],
  },
})
