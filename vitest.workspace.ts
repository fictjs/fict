import { defineWorkspace } from 'vitest/config'

export default defineWorkspace([
  'packages/runtime',
  'packages/compiler',
  'packages/vite-plugin',
  'packages/eslint-plugin',
  'packages/devtools',
  'packages/playground',
  'packages/testing-library',
  'packages/ssr',
  'packages/fict',
])
