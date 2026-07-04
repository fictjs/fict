import { defineConfig } from 'tsdown'

import { packageOutExtensions } from '../../scripts/tsdown-presets.mjs'

export default defineConfig({
  entry: 'src/index.ts',
  format: ['cjs', 'esm'],
  tsconfig: 'tsconfig.build.json',
  dts: true,
  clean: true,
  sourcemap: true,
  minify: false,
  outExtensions: packageOutExtensions,
  inputOptions(options, format) {
    if (format !== 'cjs') return
    return {
      ...options,
      transform: {
        ...options.transform,
        define: {
          ...options.transform?.define,
          'import.meta': '{}',
        },
      },
    }
  },
  deps: {
    neverBundle: ['@fictjs/runtime', /^@fictjs\/runtime\//, 'fict', /^fict\//],
  },
})
