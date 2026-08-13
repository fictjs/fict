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
    // reflection-safe deep-store tracking, SSR-safe form selection, and stable
    // context-provider ownership with reactive context accessors.
    limit: '21.2 KB',
    modifyEsbuildConfig: production,
  },
  {
    name: 'Fict (CJS)',
    path: 'packages/fict/dist/index.cjs',
    // Approved compatibility cost for stable context ownership and materializing
    // JSX values before raw-text/RCDATA coercion; CJS retains interop overhead.
    limit: '23.1 KB',
    modifyEsbuildConfig: production,
  },
]
