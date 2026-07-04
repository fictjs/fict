import { defineConfig } from 'tsdown'

import { packageOutExtensions } from '../../scripts/tsdown-presets.mjs'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'core/index': 'src/core/index.ts',
    'vite/index': 'src/vite/index.ts',
  },
  format: ['esm'],
  dts: {
    compilerOptions: {
      exactOptionalPropertyTypes: false,
      noImplicitReturns: false,
    },
  },
  clean: false,
  sourcemap: true,
  outExtensions: packageOutExtensions,
  deps: {
    neverBundle: ['vite', '@fictjs/runtime', 'open'],
  },
})
