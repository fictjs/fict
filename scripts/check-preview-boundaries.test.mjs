import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { discoverRepositoryFiles } from './api-boundary-file-discovery.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixtureFiles = [
  '.changeset/config.json',
  'SCOPE.md',
  'docs/PREVIEW.md',
  'maturity.json',
  'packages/compiler/src/types.ts',
  'packages/fict/package.json',
  'packages/router/package.json',
  'packages/runtime/package.json',
  'packages/runtime/src/loader.ts',
  'packages/ssr/package.json',
  'packages/ssr/src/experimental.ts',
  'packages/ssr/src/index.ts',
  'packages/ssr/src/render-core.ts',
  'packages/testing-library/package.json',
  'packages/webpack-plugin/package.json',
  'scripts/api-boundary-file-discovery.mjs',
  'scripts/check-preview-boundaries.mjs',
  'scripts/preview-boundary-helpers.mjs',
]

function createSourceArchiveFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fict-preview-boundary-'))
  for (const file of fixtureFiles) {
    const destination = path.join(root, file)
    mkdirSync(path.dirname(destination), { recursive: true })
    copyFileSync(path.join(repositoryRoot, file), destination)
  }

  const fixtureNodeModules = path.join(root, 'node_modules')
  mkdirSync(fixtureNodeModules)
  symlinkSync(
    path.join(repositoryRoot, 'node_modules/typescript'),
    path.join(fixtureNodeModules, 'typescript'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  return root
}

function runPreviewCheck(root) {
  return spawnSync(process.execPath, [path.join(root, 'scripts/check-preview-boundaries.mjs')], {
    cwd: root,
    encoding: 'utf8',
  })
}

test('Preview boundary check accepts a clean source archive without .git', () => {
  const root = createSourceArchiveFixture()
  try {
    assert.equal(existsSync(path.join(root, '.git')), false)
    assert.equal(discoverRepositoryFiles(root).source, 'filesystem')

    const result = runPreviewCheck(root)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Preview boundary check passed/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Preview boundary check rejects legacy loader references without .git', () => {
  const root = createSourceArchiveFixture()
  try {
    const legacySpecifier = ['fict', 'loader'].join('/')
    const violation = path.join(root, 'docs/legacy-loader.md')
    writeFileSync(violation, `import '${legacySpecifier}'\n`)

    const result = runPreviewCheck(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /legacy-loader\.md/)
    assert.match(result.stderr, /stable-looking legacy resumability entrypoint/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('scope boundary check rejects Satellite packages in fixed or ignore release groups', () => {
  for (const releaseGroup of ['fixed', 'ignore']) {
    const root = createSourceArchiveFixture()
    try {
      const configPath = path.join(root, '.changeset', 'config.json')
      const config = JSON.parse(readFileSync(configPath, 'utf8'))
      if (releaseGroup === 'fixed') {
        config.fixed[0].push('@fictjs/webpack-plugin')
      } else {
        config.ignore.push('@fictjs/webpack-plugin')
      }
      writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)

      const result = runPreviewCheck(root)
      assert.equal(result.status, 1)
      assert.match(result.stderr, /@fictjs\/webpack-plugin is (?:Satellite|a published Satellite)/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

test('scope boundary check rejects exact Core dependency pins from Satellite packages', () => {
  const root = createSourceArchiveFixture()
  try {
    const manifestPath = path.join(root, 'packages', 'webpack-plugin', 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.dependencies['@fictjs/compiler'] = 'workspace:*'
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    const result = runPreviewCheck(root)
    assert.equal(result.status, 1)
    assert.match(
      result.stderr,
      /@fictjs\/webpack-plugin must not exact-pin Core dependency @fictjs\/compiler/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
