import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: {
    compilerOptions: {
      rootDir: undefined,
      composite: false,
      skipLibCheck: true,
    },
  },
  clean: true,
  external: [
    '@fictjs/compiler',
    '@babel/core',
    '@babel/preset-typescript',
    '@babel/plugin-syntax-jsx',
  ],
})
