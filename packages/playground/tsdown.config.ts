import { defineConfig } from 'tsdown'

import { packageOutExtensions } from '../../scripts/tsdown-presets.mjs'

const external = ['vite', '@fictjs/vite-plugin', '@fictjs/compiler', '@fictjs/devtools/vite']

export default defineConfig([
  {
    entry: ['src/index.ts', 'src/cli.ts'],
    format: ['esm'],
    dts: true,
    clean: true,
    sourcemap: true,
    outExtensions: packageOutExtensions,
    deps: {
      neverBundle: external,
    },
  },
  {
    entry: {
      bin: 'src/bin.ts',
    },
    format: ['esm'],
    dts: false,
    clean: false,
    sourcemap: true,
    outExtensions: packageOutExtensions,
    banner: {
      js: '#!/usr/bin/env node',
    },
    deps: {
      neverBundle: external,
    },
  },
])
