import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { discoverRepositoryFiles } from './api-boundary-file-discovery.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixtureFiles = [
  'docs/api-freeze-v1.md',
  'docs/migration-guide.md',
  'packages/compiler/package.json',
  'packages/compiler/src/graph-host.ts',
  'packages/devtools/package.json',
  'packages/fict/package.json',
  'packages/fict/src/advanced.ts',
  'packages/fict/src/index.ts',
  'packages/fict/src/lazy.ts',
  'packages/runtime/package.json',
  'packages/runtime/src/effect.ts',
  'packages/runtime/src/index.ts',
  'packages/runtime/src/signal.ts',
  'packages/ssr/package.json',
  'packages/ssr/src/experimental.ts',
  'packages/ssr/src/index.ts',
  'packages/ssr/src/node-session-carrier.ts',
  'packages/testing-library/package.json',
  'packages/vite-plugin/package.json',
  'packages/vite-plugin/src/index.ts',
  'packages/webpack-plugin/package.json',
  'scripts/api-boundary-file-discovery.mjs',
  'scripts/check-api-boundaries.mjs',
]

function createSourceArchiveFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fict-api-boundary-'))
  for (const file of fixtureFiles) {
    const destination = path.join(root, file)
    mkdirSync(path.dirname(destination), { recursive: true })
    copyFileSync(path.join(repositoryRoot, file), destination)
  }
  return root
}

function runBoundaryCheck(root) {
  return spawnSync(process.execPath, [path.join(root, 'scripts/check-api-boundaries.mjs')], {
    cwd: root,
    encoding: 'utf8',
  })
}

test('API boundary check accepts a clean source archive without .git', () => {
  const root = createSourceArchiveFixture()
  try {
    const gitProbe = spawnSync('git', ['rev-parse', '--git-dir'], { cwd: root, encoding: 'utf8' })
    assert.notEqual(gitProbe.status, 0)
    const result = runBoundaryCheck(root)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /API boundary check passed/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('API boundary file discovery fails closed when it finds no files', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fict-api-boundary-empty-'))
  try {
    assert.throws(() => discoverRepositoryFiles(root), /repository is empty/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('API boundary check rejects violations in a source archive without .git', () => {
  const root = createSourceArchiveFixture()
  try {
    const violation = path.join(root, 'packages/runtime/src/archive-violation.ts')
    writeFileSync(violation, "import { AsyncLocalStorage } from 'node:async_hooks'\n")

    const result = runBoundaryCheck(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /runtime browser graph must not import node:async_hooks/)
    assert.match(result.stderr, /archive-violation\.ts/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('API boundary check rejects drift in frozen context signatures', () => {
  const root = createSourceArchiveFixture()
  try {
    const freezePath = path.join(root, 'docs/api-freeze-v1.md')
    const freeze = readFileSync(freezePath, 'utf8').replace(
      'export function useContextAccessor<T>(context: Context<T>): ContextAccessor<T>',
      'export function useContextAccessor<T>(context: Context<T>): T',
    )
    writeFileSync(freezePath, freeze)

    const result = runBoundaryCheck(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /missing required boundary phrase.*useContextAccessor/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
