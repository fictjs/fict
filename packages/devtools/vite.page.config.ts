import { resolve } from 'node:path'

import { defineConfig } from 'vite'

/** Build the MAIN-world hook as one classic script with no module imports. */
export default defineConfig(({ mode }) => ({
  build: {
    outDir: mode === 'firefox' ? 'build/firefox' : 'build/chrome',
    emptyOutDir: false,
    lib: {
      entry: resolve(__dirname, 'src/page/index.ts'),
      name: 'FictDevToolsPageHook',
      formats: ['iife'],
      fileName: () => 'page-hook.js',
    },
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
}))
