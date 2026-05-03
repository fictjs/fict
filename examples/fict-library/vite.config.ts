import fict from '@fictjs/vite-plugin'
import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    emptyOutDir: true,
    lib: {
      entry: {
        index: 'src/index.ts',
        toggle: 'src/toggle.ts',
      },
      formats: ['es', 'cjs'],
      fileName: (format, entryName) => `${entryName}.${format === 'es' ? 'js' : 'cjs'}`,
    },
    rollupOptions: {
      external: id => id === 'fict' || id.startsWith('fict/'),
    },
  },
  plugins: [fict({ library: true })],
})
