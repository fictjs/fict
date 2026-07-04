import { defineConfig } from 'tsdown'

import { packageOutExtensions } from '../../scripts/tsdown-presets.mjs'

export default defineConfig({
  entry: ['src/index.ts', 'src/experimental.ts', 'src/stream-runtime.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  outExtensions: packageOutExtensions,
  deps: {
    neverBundle: ['@fictjs/runtime', /^@fictjs\/runtime\//, 'linkedom'],
  },
})
