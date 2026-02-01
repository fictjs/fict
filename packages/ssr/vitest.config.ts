import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
  },
  resolve: {
    alias: [
      {
        find: '@fictjs/runtime/loader',
        replacement: fileURLToPath(new URL('../runtime/src/loader.ts', import.meta.url)),
      },
      {
        find: '@fictjs/runtime/internal',
        replacement: fileURLToPath(new URL('../runtime/src/internal.ts', import.meta.url)),
      },
      {
        find: /^@fictjs\/runtime$/,
        replacement: fileURLToPath(new URL('../runtime/src/index.ts', import.meta.url)),
      },
    ],
  },
})
