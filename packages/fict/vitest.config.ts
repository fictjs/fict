import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@fictjs\/runtime\/internal\/list$/,
        replacement: path.resolve(__dirname, '../runtime/src/internal/list.ts'),
      },
      {
        find: /^@fictjs\/runtime\/internal$/,
        replacement: path.resolve(__dirname, '../runtime/src/internal.ts'),
      },
      {
        find: /^@fictjs\/runtime\/advanced$/,
        replacement: path.resolve(__dirname, '../runtime/src/advanced.ts'),
      },
      {
        find: /^@fictjs\/runtime\/jsx-runtime$/,
        replacement: path.resolve(__dirname, '../runtime/src/jsx-runtime.ts'),
      },
      {
        find: /^@fictjs\/runtime\/jsx-dev-runtime$/,
        replacement: path.resolve(__dirname, '../runtime/src/jsx-dev-runtime.ts'),
      },
      {
        find: /^@fictjs\/runtime$/,
        replacement: path.resolve(__dirname, '../runtime/src/index.ts'),
      },
    ],
  },
  test: {
    globals: true,
    environment: 'jsdom',
    exclude: ['e2e/**', 'node_modules/**'],
    pool: 'forks',
    fileParallelism: false,
    maxWorkers: 1,
  },
})
