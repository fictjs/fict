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
    // Distributed Brotli: causal transitions 24,424 B; see its dated archive.
    limit: '24.6 KB',
    modifyEsbuildConfig: production,
  },
  {
    name: 'Fict package (CJS)',
    path: 'packages/fict/dist/index.cjs',
    // Distributed CJS includes advanced APIs: causal transitions 44,015 B.
    limit: '44.2 KB',
    modifyEsbuildConfig: production,
  },
  {
    name: 'Fict package async memo (ESM)',
    path: 'packages/fict/dist/advanced.js',
    import: '{ createAsyncMemo }',
    // Causal transitions: 8,369 B including generation readiness accounting.
    limit: '8.5 KB',
    modifyEsbuildConfig: production,
  },
  {
    name: 'Fict package sync memo (ESM)',
    path: 'packages/fict/dist/index.js',
    import: '{ createMemo }',
    // Causal transitions: 4,920 B; keep sync entry overhead separately visible.
    limit: '5 KB',
    modifyEsbuildConfig: production,
  },
  {
    name: 'Fict package resource (ESM)',
    path: 'packages/fict/dist/plus.js',
    import: '{ resource }',
    // Causal transitions: 21,362 B including shared reader readiness leases.
    limit: '21.5 KB',
    modifyEsbuildConfig: production,
  },
]
