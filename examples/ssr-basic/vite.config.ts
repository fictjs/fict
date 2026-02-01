import fict from '@fictjs/vite-plugin'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [fict({ resumable: true })],
  build: {
    minify: false,
  },
})
