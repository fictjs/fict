import { defineConfig } from 'tsup'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/jsx-runtime.ts',
    'src/jsx-dev-runtime.ts',
    'src/plus.ts',
    'src/advanced.ts',
    'src/internal.ts',
    'src/internal-list.ts',
    'src/loader.ts',
    'src/slim.ts',
  ],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  external: [
    '@fictjs/runtime',
    '@fictjs/runtime/advanced',
    '@fictjs/runtime/internal',
    '@fictjs/runtime/internal/list',
    '@fictjs/runtime/loader',
    '@fictjs/runtime/jsx-runtime',
    '@fictjs/runtime/jsx-dev-runtime',
  ],
})
