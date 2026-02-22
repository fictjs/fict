import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: true,
    clean: true,
    sourcemap: true,
    external: [
      '@modelcontextprotocol/sdk',
      'zod',
      '@babel/core',
      '@babel/plugin-syntax-jsx',
      '@babel/preset-typescript',
      '@fictjs/compiler',
      '@fictjs/eslint-plugin',
      'eslint',
      'typescript',
    ],
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
    external: [
      '@modelcontextprotocol/sdk',
      'zod',
      '@babel/core',
      '@babel/plugin-syntax-jsx',
      '@babel/preset-typescript',
      '@fictjs/compiler',
      '@fictjs/eslint-plugin',
      'eslint',
      'typescript',
    ],
  },
])
