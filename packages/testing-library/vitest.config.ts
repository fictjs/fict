import { defineConfig } from 'vitest/config'
import { resolve } from 'path'
import fict from '@fictjs/vite-plugin'

export default defineConfig({
  plugins: [
    // Use fict plugin to transform .tsx files with $state, $effect macros
    fict({
      include: ['**/*.compiled.test.tsx'],
      // Enable $state/$effect in renderHook callbacks
      reactiveScopes: ['renderHook'],
    }),
  ],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'clover', 'json'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
    },
  },
  resolve: {
    alias: {
      '@fictjs/runtime': resolve(__dirname, '../runtime/src'),
      '@fictjs/testing-library': resolve(__dirname, './src'),
      fict: resolve(__dirname, '../fict/src'),
    },
  },
})
