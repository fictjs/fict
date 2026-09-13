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
    // Distributed Brotli: async composition 23,801 B; see its dated archive.
    limit: '24 KB',
    modifyEsbuildConfig: production,
  },
  {
    name: 'Fict package (CJS)',
    path: 'packages/fict/dist/index.cjs',
    // Distributed CJS includes advanced APIs: async composition 43,149 B.
    limit: '43.3 KB',
    modifyEsbuildConfig: production,
  },
  {
    name: 'Fict package async memo (ESM)',
    path: 'packages/fict/dist/advanced.js',
    import: '{ createAsyncMemo }',
    // Async composition: 7,692 B including readiness propagation and ownership.
    limit: '7.8 KB',
    modifyEsbuildConfig: production,
  },
  {
    name: 'Fict package sync memo (ESM)',
    path: 'packages/fict/dist/index.js',
    import: '{ createMemo }',
    // Async composition: 4,780 B; keep sync entry overhead separately visible.
    limit: '4.9 KB',
    modifyEsbuildConfig: production,
  },
  {
    name: 'Fict package resource (ESM)',
    path: 'packages/fict/dist/plus.js',
    import: '{ resource }',
    // Shared graph Resource: 20,700 B, measured independently from the main entry.
    limit: '20.8 KB',
    modifyEsbuildConfig: production,
  },
]
