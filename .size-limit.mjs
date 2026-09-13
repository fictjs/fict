const production = config => ({
  ...config,
  // Measure the distributed JavaScript. Workspace paths otherwise redirect
  // @fictjs/runtime imports to src and conceal CJS packaging overhead.
  tsconfigRaw: { compilerOptions: {} },
  define: {
    ...config.define,
    __DEV__: 'false',
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
})

export default [
  {
    name: 'Fict package (ESM)',
    path: 'packages/fict/dist/index.js',
    // Distributed production Brotli: 3d763bfd 22,033 B; 877825bf 22,135 B.
    // Source-aliased historical values are retained in the dated size archive.
    limit: '22.3 KB',
    modifyEsbuildConfig: production,
  },
  {
    name: 'Fict package (CJS)',
    path: 'packages/fict/dist/index.cjs',
    // Distributed CJS: 3d763bfd 39,477 B; 877825bf 40,982 B. CommonJS
    // namespace exports retain more code than the former source-aliased check.
    limit: '41.1 KB',
    modifyEsbuildConfig: production,
  },
  {
    name: 'Fict package async memo (ESM)',
    path: 'packages/fict/dist/advanced.js',
    import: '{ createAsyncMemo }',
    // 877825bf: 6,905 B including the graph, lifecycle, and async protocol.
    limit: '7 KB',
    modifyEsbuildConfig: production,
  },
  {
    name: 'Fict package sync memo (ESM)',
    path: 'packages/fict/dist/index.js',
    import: '{ createMemo }',
    // Guard synchronous consumers independently of the new async primitive.
    limit: '4.4 KB',
    modifyEsbuildConfig: production,
  },
]
