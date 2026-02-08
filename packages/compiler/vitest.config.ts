import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const runtimeInternal = fileURLToPath(new URL('../runtime/src/internal.ts', import.meta.url))
const runtimeInternalList = fileURLToPath(
  new URL('../runtime/src/internal/list.ts', import.meta.url),
)
const runtimeIndex = fileURLToPath(new URL('../runtime/src/index.ts', import.meta.url))
const runtimeJsx = fileURLToPath(new URL('../runtime/src/jsx-runtime.ts', import.meta.url))

export default defineConfig({
  resolve: {
    alias: [
      { find: '@fictjs/runtime/jsx-runtime', replacement: runtimeJsx },
      { find: /^@fictjs\/runtime\/internal\/list$/, replacement: runtimeInternalList },
      { find: /^@fictjs\/runtime\/internal$/, replacement: runtimeInternal },
      { find: /^@fictjs\/runtime$/, replacement: runtimeIndex },
    ],
  },
  test: {
    globals: true,
    environment: 'node',
  },
})
