import fict from '@fictjs/vite-plugin'
import { defineConfig } from 'vite'

export default defineConfig({
  // Preview opt-in: generated QRL/resume ABI is not part of Core 1.0.
  plugins: [fict({ resumable: true })],
  build: {
    minify: false,
  },
})
