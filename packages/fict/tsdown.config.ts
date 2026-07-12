import { defineConfig } from 'tsdown'

import { packageOutExtensions } from '../../scripts/tsdown-presets.mjs'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'jsx-runtime': 'src/jsx-runtime.ts',
    'jsx-dev-runtime': 'src/jsx-dev-runtime.ts',
    plus: 'src/plus.ts',
    advanced: 'src/advanced.ts',
    internal: 'src/internal.ts',
    'internal-list': 'src/internal-list.ts',
    'experimental/loader': 'src/loader.ts',
    slim: 'src/slim.ts',
  },
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
