import { defineConfig } from 'vitest/config'
import fict from '@fictjs/vite-plugin'

export default defineConfig({
  plugins: [fict()],
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.d.ts'],
    },
  },
  resolve: {
    alias: {
      '@fictjs/router': new URL('./src', import.meta.url).pathname,
    },
  },
})
