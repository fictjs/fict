import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'core/index': 'src/core/index.ts',
    'vite/index': 'src/vite/index.ts',
  },
  format: ['esm'],
  dts: {
    compilerOptions: {
      exactOptionalPropertyTypes: false,
      noImplicitReturns: false,
    },
  },
  clean: false, // Don't clean - we also have extension build output
  sourcemap: true,
  external: ['vite', '@fictjs/runtime'],
})
