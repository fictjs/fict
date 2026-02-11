import { defineConfig } from 'tsup'

export default defineConfig([
  // Main entries built together to share internal state
  {
    entry: {
      index: 'src/index.ts',
      internal: 'src/internal.ts',
      'internal-list': 'src/internal/list.ts',
      advanced: 'src/advanced.ts',
      loader: 'src/loader.ts',
    },
    format: ['cjs', 'esm'],
    dts: true,
    // Keep clean disabled inside tsup: with multiple parallel configs, clean can
    // race with d.ts emission and drop jsx-runtime declaration entrypoints.
    clean: false,
    sourcemap: true,
    splitting: true, // Enable code splitting to share modules
    // Don't define __DEV__ here - let Vite handle it at runtime via define config
    // This allows devtools to work in development mode
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
