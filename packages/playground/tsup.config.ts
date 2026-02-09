import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: ['src/index.ts', 'src/cli.ts'],
    format: ['esm'],
    dts: true,
    clean: true,
    sourcemap: true,
    external: ['vite', '@fictjs/vite-plugin', '@fictjs/compiler', '@fictjs/devtools/vite'],
  },
  {
    entry: {
      bin: 'src/bin.ts',
    },
    format: ['esm'],
    dts: false,
    sourcemap: true,
    banner: {
      js: '#!/usr/bin/env node',
    },
    external: ['vite', '@fictjs/vite-plugin', '@fictjs/compiler', '@fictjs/devtools/vite'],
  },
])
