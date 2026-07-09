import { defineConfig } from 'tsdown'

import { packageOutExtensions } from '../../scripts/tsdown-presets.mjs'

export default defineConfig({
  entry: {
    extension: 'src/extension.ts',
  },
  tsconfig: 'tsconfig.build.json',
  format: ['cjs'],
  platform: 'node',
  outDir: 'dist',
  dts: false,
  clean: true,
  sourcemap: true,
  outExtensions: packageOutExtensions,
  inputOptions: options => ({
    ...options,
    resolve: {
      ...options.resolve,
      conditionNames: ['import', 'node', 'default'],
    },
  }),
  deps: {
    neverBundle: ['vscode'],
    alwaysBundle: [/.*/],
    onlyBundle: false,
  },
})
