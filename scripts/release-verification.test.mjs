import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  buildConsumerPnpmConfig,
  buildConsumerEntries,
  collectNonNodeImportTargets,
  collectExportTargets,
  findConsumerCoverageGaps,
  findNativeCompilerVersionMismatches,
  findWorkspaceProtocols,
  verifyReleaseContract,
} from './package-tarball-smoke.mjs'
import {
  dirtyCheckoutMessage,
  pnpmStoreRoot,
  releaseIsolationEnv,
  worktreeRemovalFailure,
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

test('release verification retains regression, tarball, SSR, browser, and clean-checkout gates', () => {
  assert.deepEqual(verifyReleaseContract(rootPackage, releaseWorkflow), [])
})

test('release publishing uses one dependency-ordered publisher after native certification', () => {
  assert.match(releaseWorkflow, /name: Build native compiler packages/)
  assert.match(releaseWorkflow, /name: Certify native compiler packages/)
  assert.match(releaseWorkflow, /node scripts\/publish-release-packages\.mjs/)
  assert.doesNotMatch(releaseWorkflow, /changeset publish/)
  assert.equal(rootPackage.scripts.release, 'pnpm release:plan --require-existing-packages')
})

test('precommit and release verification retain the Preview maturity boundary gate', () => {
  assert.match(rootPackage.scripts.precommit, /pnpm test:preview-boundaries/)
  assert.match(rootPackage.scripts['release:verify'], /pnpm test:preview-boundaries/)
})

test('precommit, release verification, and CI enforce the review regression suite', () => {
  assert.match(rootPackage.scripts.precommit, /pnpm test:review-regressions/)
  assert.match(rootPackage.scripts['release:verify'], /pnpm test:review-regressions/)
  assert.match(ciWorkflow, /run: pnpm test:review-regressions/)
})

test('rollout candidates only chain the immediately preceding successful main push', () => {
  assert.doesNotMatch(ciWorkflow, /^\s+status: 'completed'$/m)
  assert.match(ciWorkflow, /\.filter\(candidate => candidate\.id < context\.runId\)/)
  assert.match(ciWorkflow, /\.sort\(\(left, right\) => right\.id - left\.id\)\[0\]/)
  assert.match(ciWorkflow, /if \(run\?\.status === 'completed' && run\.conclusion === 'success'\)/)
  assert.doesNotMatch(ciWorkflow, /runs\.find\([^\n]+conclusion === 'success'/)
  assert.match(ciWorkflow, /value\.schemaVersion === 3/)
  assert.match(ciWorkflow, /restarting the consecutive count/)
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

test('compiler tarballs pin all eight native packages to the facade version', () => {
  const optionalDependencies = Object.fromEntries(
    Array.from({ length: 8 }, (_, index) => [`@fictjs/compiler-platform-${index}`, '1.2.3']),
  )
  assert.deepEqual(
    findNativeCompilerVersionMismatches({
      name: '@fictjs/compiler',
      version: '1.2.3',
      optionalDependencies,
    }),
    [],
  )
  optionalDependencies['@fictjs/compiler-platform-7'] = '1.2.2'
  assert.deepEqual(
    findNativeCompilerVersionMismatches({
      name: '@fictjs/compiler',
      version: '1.2.3',
      optionalDependencies,
    }),
    ['@fictjs/compiler-platform-7@1.2.2'],
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

test('consumer plan rejects any publishable package missing a consumption mode', () => {
  const manifests = [
    {
      name: '@fictjs/complete',
      exports: {
        '.': {
          types: './dist/index.d.ts',
          import: './dist/index.js',
          require: './dist/index.cjs',
        },
      },
    },
    {
      name: '@fictjs/esm-only',
      exports: {
        '.': {
          import: { types: './dist/index.d.ts', default: './dist/index.js' },
        },
      },
    },
  ]

  assert.deepEqual(findConsumerCoverageGaps(manifests, buildConsumerEntries(manifests)), [
    '@fictjs/esm-only:cjs',
    '@fictjs/esm-only:cjsTypes',
  ])
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
      new Set(['@fictjs/compiler-linux-x64-gnu']),
    ),
    {
      overrides: {
        vulnerable: '1.0.1',
        'fict>@fictjs/runtime': 'file:../packs/runtime.tgz',
        '@fictjs/router>@fictjs/runtime': 'file:../packs/runtime.tgz',
        '@fictjs/compiler>@fictjs/compiler-linux-x64-gnu': '-',
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

test('clean checkout isolates Turbo artifacts and uses CI browser behavior', () => {
  assert.deepEqual(releaseIsolationEnv('/tmp/fict-clean', '/cache/pnpm'), {
    CI: 'true',
    FICT_PNPM_STORE_DIR: '/cache/pnpm',
    HUSKY: '0',
    TURBO_CACHE_DIR: '/tmp/fict-clean/.turbo/release-cache',
  })
})

test('clean checkout fails when its temporary worktree cannot be removed', () => {
  assert.equal(worktreeRemovalFailure(0, '/tmp/fict-clean'), null)
  assert.equal(
    worktreeRemovalFailure(128, '/tmp/fict-clean'),
    '[release-verify-clean] Failed to remove temporary worktree /tmp/fict-clean',
  )
})

test('HIR output-size samples use checkout-independent source identities', () => {
  const filename = guardrailSampleFilename('resumable-handler')
  assert.equal(
    filename.endsWith(path.join('virtual', 'fict-guardrails', 'resumable-handler.tsx')),
    true,
  )
  assert.equal(filename.includes('/fict-release-checkout-'), false)
})
