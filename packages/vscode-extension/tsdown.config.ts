import { defineConfig } from 'tsdown'

import { packageOutExtensions } from '../../scripts/tsdown-presets.mjs'

export default defineConfig({
  entry: {
    extension: 'src/extension.ts',
  },
  format: ['cjs'],
  platform: 'node',
  outDir: 'dist',
  dts: false,
  clean: true,
  sourcemap: true,
  outExtensions: packageOutExtensions,
  deps: {
    neverBundle: ['vscode'],
  },
})
