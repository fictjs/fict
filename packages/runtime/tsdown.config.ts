import { defineConfig } from 'tsdown'

import { packageOutExtensions } from '../../scripts/tsdown-presets.mjs'

const common = {
  clean: false,
  sourcemap: true,
  outExtensions: packageOutExtensions,
}

export default defineConfig([
  {
    ...common,
    entry: {
      index: 'src/index.ts',
      internal: 'src/internal.ts',
      'internal-list': 'src/internal/list.ts',
      advanced: 'src/advanced.ts',
      loader: 'src/loader.ts',
    },
    format: ['cjs', 'esm'],
    dts: true,
  },
  {
    ...common,
    entry: 'src/jsx-runtime.ts',
    format: ['cjs', 'esm'],
    dts: true,
  },
  {
    ...common,
    entry: 'src/jsx-dev-runtime.ts',
    format: ['cjs', 'esm'],
    dts: true,
    define: {
      __DEV__: 'true',
    },
  },
  {
    ...common,
    entry: {
      'index.dev': 'src/index.ts',
    },
    format: ['esm'],
    dts: false,
    define: {
      __DEV__: 'true',
    },
  },
])
