import { defineWorkspace } from 'vitest/config'

export default defineWorkspace([
  'packages/runtime',
  'packages/compiler-ts',
  'packages/vite-plugin',
  'packages/eslint-plugin',
])
