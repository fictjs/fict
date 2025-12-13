import { defineConfig } from 'vite'
import fict from '@fictjs/vite-plugin'
import path from 'path'

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
        find: '@fictjs/runtime',
        replacement: path.resolve(__dirname, '../../runtime/src/index.ts'),
      },
    ],
  },
})
