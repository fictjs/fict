import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: true,
    clean: true,
    sourcemap: true,
    external: ['@modelcontextprotocol/sdk', 'zod'],
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
    external: ['@modelcontextprotocol/sdk', 'zod'],
  },
])
