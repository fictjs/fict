import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))

const suites = [
  {
    name: 'SSR HTML serialization, CSP, and compatibility-global isolation',
    packageDir: 'packages/ssr',
    files: [
      'test/html-serializer.test.ts',
      'test/index.test.ts',
      'test/globals.test.ts',
      'test/streaming.test.ts',
    ],
  },
  {
    name: 'Vite resumable handler extraction',
    packageDir: 'packages/vite-plugin',
    files: ['src/__tests__/index.test.ts'],
  },
  {
    name: 'Runtime selector and store ownership',
    packageDir: 'packages/runtime',
    files: ['test/signal.test.ts', 'test/store.test.ts'],
  },
  {
    name: 'Runtime snapshot, prototype, Proxy, and SSR session security',
    packageDir: 'packages/runtime',
    files: [
      'test/serialize.test.ts',
      'test/loader.test.ts',
      'test/resume-lifecycle.test.ts',
      'test/props-proxy.test.ts',
      'test/ssr-session.test.ts',
    ],
  },
  {
    name: 'Public resource and store behavior',
    packageDir: 'packages/fict',
    files: ['test/resource.test.ts', 'test/store.test.ts'],
  },
  {
    name: 'Router matching, resources, forms, redirects, and scroll',
    packageDir: 'packages/router',
    files: [
      'test/utils.test.ts',
      'test/data.test.ts',
      'test/resource.integration.test.tsx',
      'test/router.integration.test.tsx',
      'test/scroll.test.ts',
    ],
  },
  {
    name: 'Testing-library delayed condition failures',
    packageDir: 'packages/testing-library',
    files: ['test/testEffect.test.ts'],
  },
  {
    name: 'ESLint flat configuration and scoped bindings',
    packageDir: 'packages/eslint-plugin',
    files: [
      '__tests__/index.test.ts',
      '__tests__/no-direct-mutation.test.ts',
      '__tests__/no-state-destructure-write.test.ts',
      '__tests__/no-third-party-props-spread.test.ts',
      '__tests__/no-unsafe-props-spread.test.ts',
    ],
  },
  {
    name: 'Webpack empty-module output',
    packageDir: 'packages/webpack-plugin',
    files: ['src/__tests__/cold-build.test.ts'],
  },
  {
    name: 'DevTools extension bridge, Vite options, and serialization',
    packageDir: 'packages/devtools',
    files: [
      'test/extension-message-chain.test.ts',
      'test/page-hook-entry.test.ts',
      'test/live-trace-observer.test.ts',
      'test/vite-live-trace.test.ts',
      'test/component-name-transformer.test.ts',
      'test/vite-options.test.ts',
      'test/serializer-safety.test.ts',
    ],
  },
  {
    name: 'Playground failed-session cleanup',
    packageDir: 'packages/playground',
    files: ['test/session-creation-cleanup.test.ts'],
  },
  {
    name: 'VS Code source detection and live trace client',
    packageDir: 'packages/vscode-extension',
    files: [
      'test/analyzer-client.test.ts',
      'test/static-analyzer.test.ts',
      'test/live-client.test.ts',
    ],
  },
]

function assertSuiteFilesExist() {
  const missing = []
  for (const suite of suites) {
    for (const file of suite.files) {
      const absolutePath = path.join(repositoryRoot, suite.packageDir, file)
      if (!existsSync(absolutePath)) missing.push(path.relative(repositoryRoot, absolutePath))
    }
  }

  if (missing.length > 0) {
    throw new Error(`Review regression suite references missing files:\n${missing.join('\n')}`)
  }
}

function runSuite(suite) {
  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const env = { ...process.env }
  delete env.FICT_STRICT_GUARANTEE

  process.stdout.write(`\n[review-regressions] ${suite.name}\n`)
  const result = spawnSync(
    command,
    ['--dir', suite.packageDir, 'exec', 'vitest', 'run', ...suite.files, '--reporter=dot'],
    {
      cwd: repositoryRoot,
      env,
      stdio: 'inherit',
    },
  )

  if (result.error) throw result.error
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1
    return false
  }
  return true
}

assertSuiteFilesExist()

for (const suite of suites) {
  if (!runSuite(suite)) break
}
