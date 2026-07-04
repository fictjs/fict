import { defineConfig } from 'tsdown'

import { packageOutExtensions } from '../../scripts/tsdown-presets.mjs'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/jsx-runtime.ts',
    'src/jsx-dev-runtime.ts',
    'src/plus.ts',
    'src/advanced.ts',
    'src/internal.ts',
    'src/internal-list.ts',
    'src/loader.ts',
    'src/slim.ts',
  ],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  outExtensions: packageOutExtensions,
  deps: {
    neverBundle: ['@fictjs/runtime', /^@fictjs\/runtime\//],
  },
})
