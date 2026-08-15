const production = config => ({
  ...config,
  define: {
    ...config.define,
    __DEV__: 'false',
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
})

export default [
  {
    name: 'Fict (ESM)',
    path: 'packages/fict/dist/index.js',
    // Approved production baseline after cross-module correctness, resumability,
    // hydration repair, full namespace semantics, selector ownership, and
    // reflection-safe deep-store tracking, SSR-safe form selection, stable
    // context-provider ownership, and the non-disableable production cycle guard.
    limit: '21.4 KB',
    modifyEsbuildConfig: production,
  },
  {
    name: 'Fict (CJS)',
    path: 'packages/fict/dist/index.cjs',
    // Approved compatibility cost for stable context ownership, materializing
    // JSX values before raw-text/RCDATA coercion, and the production cycle guard;
    // CJS retains interop overhead.
    limit: '23.3 KB',
    modifyEsbuildConfig: production,
  },
]
