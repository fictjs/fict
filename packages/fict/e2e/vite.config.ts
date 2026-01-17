import path from 'path'

import fict from '@fictjs/vite-plugin'
import { defineConfig } from 'vite'

const stripRuntimePrebundle = () => ({
  name: 'fict-e2e-strip-runtime-prebundle',
  configResolved(resolved: { optimizeDeps: { include?: string[] } }) {
    if (!resolved.optimizeDeps) return
    const include = resolved.optimizeDeps.include ?? []
    resolved.optimizeDeps.include = include.filter(id => !id.startsWith('@fictjs/runtime'))
  },
})

export default defineConfig({
  plugins: [fict(), stripRuntimePrebundle()],
  cacheDir: path.resolve(__dirname, '../node_modules/.vite-e2e-v5'),
  optimizeDeps: {
    noDiscovery: true,
    include: [],
    exclude: [
      '@fictjs/runtime',
      '@fictjs/runtime/internal',
      '@fictjs/runtime/advanced',
      '@fictjs/runtime/jsx-runtime',
      path.resolve(__dirname, '../../runtime/src/dev-entry.ts'),
    ],
  },
  resolve: {
    alias: [
      { find: 'fict/plus', replacement: path.resolve(__dirname, '../src/plus.ts') },
      { find: 'fict/advanced', replacement: path.resolve(__dirname, '../src/advanced.ts') },
      { find: 'fict', replacement: path.resolve(__dirname, '../src/index.ts') },
      {
        find: '@fictjs/runtime/jsx-runtime',
        replacement: path.resolve(__dirname, '../../runtime/src/jsx-runtime.ts'),
      },
      {
        find: '@fictjs/runtime/internal',
        replacement: path.resolve(__dirname, '../../runtime/src/dev-entry.ts'),
      },
      {
        find: '@fictjs/runtime/advanced',
        replacement: path.resolve(__dirname, '../../runtime/src/advanced.ts'),
      },
      {
        find: '@fictjs/runtime',
        replacement: path.resolve(__dirname, '../../runtime/src/dev-entry.ts'),
      },
    ],
  },
})
