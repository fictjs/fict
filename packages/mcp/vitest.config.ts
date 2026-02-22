import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.{test,spec}.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
})
