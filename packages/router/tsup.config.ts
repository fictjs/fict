import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  minify: false,
  external: ['@fictjs/runtime', '@fictjs/runtime/advanced', 'fict'],
  esbuildOptions(options) {
    options.jsx = 'automatic'
    options.jsxImportSource = '@fictjs/runtime'
  },
})
