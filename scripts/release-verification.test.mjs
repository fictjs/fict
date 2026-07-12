import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  buildConsumerPnpmConfig,
  buildConsumerEntries,
  collectNonNodeImportTargets,
  collectExportTargets,
  findWorkspaceProtocols,
  verifyReleaseContract,
} from './package-tarball-smoke.mjs'
import {
  dirtyCheckoutMessage,
  pnpmStoreRoot,
  releaseIsolationEnv,
} from './release-verify-clean.mjs'
import { guardrailSampleFilename } from './hir-guardrails.mjs'

const rootPackage = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const releaseWorkflow = readFileSync(
  new URL('../.github/workflows/release.yml', import.meta.url),
  'utf8',
)
const ciWorkflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
const ssrPackage = JSON.parse(
  readFileSync(new URL('../packages/ssr/package.json', import.meta.url), 'utf8'),
)

test('release verification retains tarball, SSR matrix, browser E2E, and clean-checkout gates', () => {
  assert.deepEqual(verifyReleaseContract(rootPackage, releaseWorkflow), [])
})

test('precommit and release verification retain the Preview maturity boundary gate', () => {
  assert.match(rootPackage.scripts.precommit, /pnpm test:preview-boundaries/)
  assert.match(rootPackage.scripts['release:verify'], /pnpm test:preview-boundaries/)
})

test('browser E2E continuously includes production-shaped real applications and scheduled soak', () => {
  assert.match(rootPackage.scripts['test:e2e'], /pnpm test:real-apps/)
  assert.match(rootPackage.scripts['test:real-apps'], /examples:build-real-apps/)
  assert.match(rootPackage.scripts['test:real-apps'], /playwright\.config\.ts/)
  assert.match(ciWorkflow, /FICT_REAL_APP_SOAK_MS/)
  assert.match(ciWorkflow, /180000/)
})

test('packed manifests reject unresolved workspace protocols', () => {
  assert.deepEqual(
    findWorkspaceProtocols({
      dependencies: { '@fictjs/runtime': 'workspace:*', external: '^1.0.0' },
      peerDependencies: { fict: 'workspace:^' },
    }),
    ['dependencies.@fictjs/runtime', 'peerDependencies.fict'],
  )
})

test('archive export validation discovers nested runtime and declaration targets', () => {
  assert.deepEqual(
    collectExportTargets({
      '.': {
        node: { import: './dist/index.node.js', require: './dist/index.node.cjs' },
        import: { types: './dist/index.d.ts', default: './dist/index.js' },
      },
    }),
    ['dist/index.d.ts', 'dist/index.js', 'dist/index.node.cjs', 'dist/index.node.js'],
  )
})

test('consumer plan covers explicit ESM, CJS, and condition-specific declarations', () => {
  assert.deepEqual(
    buildConsumerEntries([
      {
        name: '@fictjs/example',
        exports: {
          '.': {
            import: { types: './dist/index.d.ts', default: './dist/index.js' },
            require: { types: './dist/index.d.cts', default: './dist/index.cjs' },
          },
          './browser-asset.js': './dist/browser-asset.js',
        },
      },
    ]),
    {
      esm: ['@fictjs/example'],
      cjs: ['@fictjs/example'],
      esmTypes: ['@fictjs/example'],
      cjsTypes: ['@fictjs/example'],
    },
  )
})

test('tarball consumers exercise SSR imports shadowed by Node export conditions', () => {
  assert.deepEqual(collectNonNodeImportTargets([ssrPackage]), [
    {
      packageName: '@fictjs/ssr',
      subpath: '.',
      target: 'dist/index.js',
    },
    {
      packageName: '@fictjs/ssr',
      subpath: './experimental',
      target: 'dist/experimental.js',
    },
  ])
})

test('consumer overrides force transitive workspace dependencies to local tarballs', () => {
  assert.deepEqual(
    buildConsumerPnpmConfig(
      { overrides: { vulnerable: '1.0.1' } },
      [
        {
          name: 'fict',
          dependencies: { '@fictjs/runtime': '0.27.0' },
        },
        {
          name: '@fictjs/router',
          dependencies: { '@fictjs/runtime': '0.27.0' },
          peerDependencies: { fict: '>=0.3.0' },
        },
      ],
      {
        fict: 'file:../packs/fict.tgz',
        '@fictjs/runtime': 'file:../packs/runtime.tgz',
      },
    ),
    {
      overrides: {
        vulnerable: '1.0.1',
        'fict>@fictjs/runtime': 'file:../packs/runtime.tgz',
        '@fictjs/router>@fictjs/runtime': 'file:../packs/runtime.tgz',
      },
    },
  )
})

test('clean-checkout diagnostics preserve the offending porcelain entries', () => {
  assert.equal(
    dirtyCheckoutMessage(' M package.json\n?? local.txt'),
    'Refusing to verify an uncommitted checkout:\n   M package.json\n  ?? local.txt',
  )
  assert.equal(dirtyCheckoutMessage(''), null)
})

test('clean checkout reuses the content-addressed store without sharing installed modules', () => {
  assert.equal(pnpmStoreRoot('/repo/.pnpm-store/v3'), '/repo/.pnpm-store')
  assert.equal(pnpmStoreRoot('/cache/pnpm'), '/cache/pnpm')
})

test('clean checkout isolates Turbo artifacts inside its temporary worktree', () => {
  assert.deepEqual(releaseIsolationEnv('/tmp/fict-clean', '/cache/pnpm'), {
    FICT_PNPM_STORE_DIR: '/cache/pnpm',
    HUSKY: '0',
    TURBO_CACHE_DIR: '/tmp/fict-clean/.turbo/release-cache',
  })
})

test('HIR output-size samples use checkout-independent source identities', () => {
  const filename = guardrailSampleFilename('resumable-handler')
  assert.equal(
    filename.endsWith(path.join('virtual', 'fict-guardrails', 'resumable-handler.tsx')),
    true,
  )
  assert.equal(filename.includes('/fict-release-checkout-'), false)
})
