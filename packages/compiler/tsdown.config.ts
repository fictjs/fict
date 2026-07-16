import { defineConfig } from 'tsdown'

import { packageOutExtensions } from '../../scripts/tsdown-presets.mjs'

export default defineConfig({
  entry: {
    'graph-host': 'src/graph-host.ts',
    index: 'src/index.ts',
    'native-loader': 'src/native-loader.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  outExtensions: packageOutExtensions,
  outputOptions: {
    exports: 'named',
  },
})
