import fict from '@fictjs/vite-plugin'
import fictDevTools from '@fictjs/devtools/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [fict(), fictDevTools()],
})
