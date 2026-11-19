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
    // Distributed ESM with VNode reconciliation: 31,432 B at 7a191bd3.
    limit: '31.6 KB',
    modifyEsbuildConfig: production,
  },
  {
    name: 'Fict package (CJS)',
    path: 'packages/fict/dist/index.cjs',
    // Distributed CJS with advanced APIs and VNode reconciliation: 48,624 B.
    limit: '48.8 KB',
    modifyEsbuildConfig: production,
  },
  {
    name: 'Fict package async memo (ESM)',
    path: 'packages/fict/dist/advanced.js',
    import: '{ createAsyncMemo }',
    // Eager hydration leaves this selective import unchanged at 8,365 B.
    limit: '8.5 KB',
    modifyEsbuildConfig: production,
  },
  {
    name: 'Fict package sync memo (ESM)',
    path: 'packages/fict/dist/index.js',
    import: '{ createMemo }',
    // Eager hydration leaves this selective import unchanged at 4,923 B.
    limit: '5 KB',
    modifyEsbuildConfig: production,
  },
  {
    name: 'Fict package resource (ESM)',
    path: 'packages/fict/dist/plus.js',
    import: '{ resource }',
    // Resource includes the shared Suspense renderer and reconciler: 26,859 B.
    limit: '27 KB',
    modifyEsbuildConfig: production,
  },
]
