import path from 'path'

import fict from '@fictjs/vite-plugin'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [fict()],
  resolve: {
    alias: [
      { find: 'fict', replacement: path.resolve(__dirname, '../src/index.ts') },
      {
        find: '@fictjs/runtime/jsx-runtime',
        replacement: path.resolve(__dirname, '../../runtime/src/jsx-runtime.ts'),
      },
      {
        find: '@fictjs/runtime/internal',
        replacement: path.resolve(__dirname, '../../runtime/src/internal.ts'),
      },
      {
        find: '@fictjs/runtime/advanced',
        replacement: path.resolve(__dirname, '../../runtime/src/advanced.ts'),
      },
      {
        find: '@fictjs/runtime',
        replacement: path.resolve(__dirname, '../../runtime/src/index.ts'),
      },
    ],
  },
})
