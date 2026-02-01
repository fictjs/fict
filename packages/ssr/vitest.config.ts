import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
  },
  resolve: {
    alias: {
      '@fictjs/runtime/internal': fileURLToPath(
        new URL('../runtime/src/internal.ts', import.meta.url),
      ),
      '@fictjs/runtime': fileURLToPath(new URL('../runtime/src/index.ts', import.meta.url)),
    },
  },
})
