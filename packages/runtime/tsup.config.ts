import { defineConfig } from 'tsup'

export default defineConfig([
  // Main entries built together to share internal state
  {
    entry: ['src/index.ts', 'src/internal.ts', 'src/advanced.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    clean: true,
    sourcemap: true,
    splitting: true, // Enable code splitting to share modules
    define: {
      __DEV__: 'false',
    },
  },
  // JSX runtime
  {
    entry: ['src/jsx-runtime.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    sourcemap: true,
  },
  // JSX dev runtime
  {
    entry: ['src/jsx-dev-runtime.ts'],
    format: ['cjs', 'esm'],
    dts: true,
    sourcemap: true,
    define: {
      __DEV__: 'true',
    },
  },
  // Dev build (with __DEV__ = true)
  {
    entry: { 'index.dev': 'src/index.ts' },
    format: ['esm'],
    sourcemap: true,
    define: {
      __DEV__: 'true',
    },
  },
])
