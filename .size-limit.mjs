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
    // reflection-safe deep-store tracking.
    limit: '20.7 KB',
    modifyEsbuildConfig: production,
  },
  {
    name: 'Fict (CJS)',
    path: 'packages/fict/dist/index.cjs',
    limit: '22.6 KB',
    modifyEsbuildConfig: production,
  },
]
