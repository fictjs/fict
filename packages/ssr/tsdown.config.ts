import { defineConfig } from 'tsdown'

import { packageOutExtensions } from '../../scripts/tsdown-presets.mjs'

export default defineConfig({
  entry: ['src/index.ts', 'src/experimental.ts', 'src/stream-runtime.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  outExtensions: packageOutExtensions,
  inputOptions(options, format) {
    if (format !== 'cjs') return
    return {
      ...options,
      transform: {
        ...options.transform,
        define: {
          ...options.transform?.define,
          __FICT_NODE_REQUIRE__: 'require',
        },
      },
    }
  },
  deps: {
    neverBundle: ['@fictjs/runtime', /^@fictjs\/runtime\//, 'linkedom'],
  },
})
