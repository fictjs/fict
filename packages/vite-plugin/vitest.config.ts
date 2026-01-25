import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30000, // Babel transforms can be slow on CI runners
  },
})
