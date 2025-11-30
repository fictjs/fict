import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    clean: true,
    sourcemap: true,
    treeshake: true,
    define: {
      __DEV__: 'false',
    },
  },
  {
    entry: ['src/jsx-runtime.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    sourcemap: true,
  },
  {
    entry: { 'index.dev': 'src/index.ts' },
    format: ['esm'],
    sourcemap: true,
    define: {
      __DEV__: 'true',
    },
  },
])
