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
    name: 'Fict workspace (ESM)',
    path: 'packages/fict/dist/index.js',
    // Production Brotli baseline after hydration, cleanup/selector ownership,
    // deep-store correctness, and keyed-rendering optimizations. Isolated builds
    // with the same dependencies: ecacec8b 21,573 B; 27dbe2d9 21,998 B;
    // 64f2f083 22,076 B (+78 B for the latest performance optimizations).
    // Async graph input invalidation: 22,119 B (+43 B). This legacy check
    // follows workspace TypeScript aliases; packed artifacts are qualified separately.
    limit: '22.2 KB',
    modifyEsbuildConfig: production,
  },
  {
    name: 'Fict workspace (CJS)',
    path: 'packages/fict/dist/index.cjs',
    // The same production baseline with CJS interop overhead. Isolated builds:
    // ecacec8b 23,527 B; 27dbe2d9 23,934 B; 64f2f083 24,021 B
    // (+87 B for the latest performance optimizations).
    // Explicit async advanced exports: 25,505 B (+1,484 B). CJS imports the
    // advanced namespace used by the main facade. ESM omits unused async code.
    limit: '25.6 KB',
    modifyEsbuildConfig: production,
  },
  {
    name: 'Fict workspace async memo (ESM)',
    path: 'packages/fict/dist/advanced.js',
    import: '{ createAsyncMemo }',
    limit: '6.5 KB',
    modifyEsbuildConfig: production,
  },
]
