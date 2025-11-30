import { resolve } from 'path'

import { defineConfig } from 'vite'

export default defineConfig(({ mode }) => ({
  build: {
    outDir: mode === 'firefox' ? 'build/firefox' : 'build/chrome',
    rollupOptions: {
      input: {
        panel: resolve(__dirname, 'src/panel/index.html'),
        background: resolve(__dirname, 'src/background/index.ts'),
        content: resolve(__dirname, 'src/content/index.ts'),
      },
      output: {
        entryFileNames: '[name].js',
      },
    },
  },
}))
