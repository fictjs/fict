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
    // Eager async hydration: 26,294 B; see async-ssr-hydration-size archive.
    limit: '26.5 KB',
    modifyEsbuildConfig: production,
  },
  {
    name: 'Fict package (CJS)',
    path: 'packages/fict/dist/index.cjs',
    // Distributed CJS includes advanced APIs and hydration: 45,141 B.
    limit: '45.3 KB',
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
    // Resource and its shared Suspense hydration support: 22,085 B.
    limit: '22.2 KB',
    modifyEsbuildConfig: production,
  },
]
