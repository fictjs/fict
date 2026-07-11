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
    // hydration repair, and full HTML/SVG/MathML namespace semantics.
    limit: '20.5 KB',
    modifyEsbuildConfig: production,
  },
  {
    name: 'Fict (CJS)',
    path: 'packages/fict/dist/index.cjs',
    limit: '22.4 KB',
    modifyEsbuildConfig: production,
  },
]
