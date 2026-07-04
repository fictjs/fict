import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 60000, // Babel transforms can be slow on CI coverage runners
  },
})
