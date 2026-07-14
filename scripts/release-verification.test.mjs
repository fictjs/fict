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
const rolloutState = JSON.parse(
  readFileSync(new URL('../.github/compiler-rollout-state.json', import.meta.url), 'utf8'),
)
const rolloutReview = JSON.parse(
  readFileSync(new URL('../.github/compiler-rollout-review.json', import.meta.url), 'utf8'),
)
const rolloutReadiness = readFileSync(
  new URL('./compiler-rollout-readiness.mjs', import.meta.url),
  'utf8',
)
const releaseWorkflow = readFileSync(
  new URL('../.github/workflows/release.yml', import.meta.url),
  'utf8',
)
const ciWorkflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
const turboConfig = JSON.parse(readFileSync(new URL('../turbo.json', import.meta.url), 'utf8'))
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

test('CI and release fail closed on advisories in both Rust lockfiles', () => {
  assert.equal(
    rootPackage.scripts['security:audit:rust'],
    'cargo audit --deny warnings && cargo audit --deny warnings --file fuzz/Cargo.lock',
  )
  assert.match(
    rootPackage.scripts['release:verify'],
    /^pnpm security:audit:prod && pnpm security:audit:rust &&/,
  )

  for (const workflow of [ciWorkflow, releaseWorkflow]) {
    assert.match(workflow, /CARGO_AUDIT_VERSION: 0\.22\.2/)
    assert.match(
      workflow,
      /cargo install cargo-audit --version "\$\{CARGO_AUDIT_VERSION\}" --locked/,
    )
    assert.match(
      workflow,
      /test "\$\(cargo audit --version\)" = "cargo-audit \$\{CARGO_AUDIT_VERSION\}"/,
    )
    assert.doesNotMatch(workflow, /cargo audit[^\n]*--ignore/)
  }

  assert.match(ciWorkflow, /name: Audit locked Rust dependencies[\s\S]*?pnpm security:audit:rust/)
  assert.match(releaseWorkflow, /^\s+cargo audit --deny warnings$/m)
  assert.match(releaseWorkflow, /^\s+cargo audit --deny warnings --file fuzz\/Cargo\.lock$/m)
})

test('Babel preset deprecation verification builds its compiler dependency first', () => {
  assert.match(
    rootPackage.scripts['test:babel-preset:deprecation'],
    /^pnpm --filter @fictjs\/compiler build && pnpm --filter @fictjs\/babel-preset build &&/,
  )
})

test('native bundler typechecks wait for compiler declarations in clean checkouts', () => {
  for (const task of ['@fictjs/vite-plugin#typecheck', '@fictjs/webpack-plugin#typecheck']) {
    assert.deepEqual(turboConfig.tasks[task]?.dependsOn, ['@fictjs/compiler#build'])
  }
})

test('rollout representative application builds its workspace dependency closure', () => {
  assert.match(
    ciWorkflow,
    /name: Build a representative application with the Rust backend[\s\S]*?run: pnpm --filter fict-example-real-apps\.\.\. build/,
  )
})

test('compiler and top-level release gates enforce Rust architecture and complexity budgets', () => {
  assert.match(rootPackage.scripts['release:verify'], /pnpm guardrails:rust-crates/)
  assert.match(rootPackage.scripts['release:compiler:verify'], /pnpm guardrails:rust-crates/)
  assert.match(ciWorkflow, /^\s+pnpm guardrails:rust-crates$/m)
})

test('rollout candidates only chain the immediately preceding successful main push', () => {
  assert.doesNotMatch(ciWorkflow, /^\s+status: 'completed'$/m)
  assert.match(ciWorkflow, /\.filter\(candidate => candidate\.id < context\.runId\)/)
  assert.match(ciWorkflow, /\.sort\(\(left, right\) => right\.id - left\.id\)\[0\]/)
  assert.match(ciWorkflow, /if \(run\?\.status === 'completed' && run\.conclusion === 'success'\)/)
  assert.doesNotMatch(ciWorkflow, /runs\.find\([^\n]+conclusion === 'success'/)
  assert.match(ciWorkflow, /value\.schemaVersion === 5/)
  assert.match(ciWorkflow, /restarting the consecutive count/)
})

test('controlled native builds embed the workflow source revision', () => {
  const revisionBinding = /FICT_COMPILER_BUILD_REVISION: \$\{\{ github\.sha \}\}/
  assert.match(ciWorkflow, revisionBinding)
  assert.match(releaseWorkflow, revisionBinding)
})

test('release aggregates and certifies all revision-bound native runtime evidence', () => {
  assert.equal((releaseWorkflow.match(/--node-lane/g) ?? []).length, 2)
  assert.equal((releaseWorkflow.match(/--expected-revision/g) ?? []).length, 2)
  assert.match(releaseWorkflow, /pattern: fict-native-evidence-\*/)
  assert.match(releaseWorkflow, /merge-multiple: true/)
  assert.match(releaseWorkflow, /verify-runtime-evidence/)
  assert.match(releaseWorkflow, /--artifacts "\$\{RUNNER_TEMP\}\/native-packages"/)
  assert.match(releaseWorkflow, /--revision "\$\{GITHUB_SHA\}"/)
  assert.match(releaseWorkflow, /--output "\$\{RUNNER_TEMP\}\/native-certification\.json"/)
  assert.match(releaseWorkflow, /name: fict-native-certification-\$\{\{ github\.sha \}\}/)

  const certificationJob = releaseWorkflow.indexOf('native-certification:')
  const releaseJob = releaseWorkflow.indexOf('\n  release:')
  const download = releaseWorkflow.indexOf('name: Download all native runtime evidence')
  const certification = releaseWorkflow.indexOf(
    'name: Certify the complete native runtime evidence matrix',
  )
  const publishPreflight = releaseWorkflow.indexOf(
    'name: Preflight the complete atomic native publish set',
  )
  assert.ok(certificationJob >= 0 && certificationJob < releaseJob)
  assert.ok(download >= 0 && download < certification)
  assert.ok(certification < publishPreflight)

  const certificationSource = releaseWorkflow.slice(certificationJob, releaseJob)
  const releaseSource = releaseWorkflow.slice(releaseJob)
  assert.match(certificationSource, /needs: \[native-build, native-runtime\]/)
  assert.doesNotMatch(certificationSource, /github\.event_name == 'push'/)
  assert.match(releaseSource, /needs: native-certification/)
  assert.doesNotMatch(releaseSource, /Download all native runtime evidence/)
})

test('Rust-default approval binds the complete native certification to its candidate', () => {
  assert.equal(rolloutState.schemaVersion, 3)
  assert.equal(rolloutState.nativeCertificationPath, '.github/compiler-native-certification.json')
  assert.equal(rolloutReview.schemaVersion, 3)
  assert.equal(rolloutReview.nativeCertificationDigest, null)
  assert.match(rolloutReadiness, /assertNativeCertification\(nativeCertification, evidence\)/)
  assert.match(rolloutReadiness, /payload\.compilerBuildRevision !== evidence\.sourceRevision/)
  assert.match(rolloutReadiness, /payload\.compilerBuildId !== evidence\.compilerBuildId/)
  assert.match(
    rolloutReadiness,
    /review\.nativeCertificationDigest !== nativeCertification\.certificationDigest/,
  )
})

test('rollout candidates are finalized only after every required CI gate succeeds', () => {
  const rawEvidenceUpload = ciWorkflow.indexOf('name: Upload raw rollout evidence')
  const finalizer = ciWorkflow.indexOf('compiler-rollout-finalize:')
  assert.notEqual(rawEvidenceUpload, -1)
  assert.notEqual(finalizer, -1)
  assert.ok(rawEvidenceUpload < finalizer)

  const producer = ciWorkflow.slice(rawEvidenceUpload, finalizer)
  const finalizerSource = ciWorkflow.slice(finalizer)
  assert.match(producer, /name: compiler-rollout-raw-evidence/)
  assert.doesNotMatch(producer, /name: compiler-rollout-candidate/)
  assert.doesNotMatch(producer, /Seal candidate evidence/)

  for (const job of [
    'rust-fuzz',
    'rust-native',
    'compiler-rollout',
    'lint',
    'typecheck',
    'strict-guarantee',
    'perf-guardrails',
    'test',
    'e2e',
    'test-opt-out',
    'test-ssr-edge',
    'build',
  ]) {
    assert.match(finalizerSource, new RegExp(`^\\s+- ${job}$`, 'm'))
  }
  assert.match(finalizerSource, /always\(\)/)
  assert.match(finalizerSource, /needs\['compiler-rollout'\]\.result == 'success'/)
  assert.match(finalizerSource, /needs\.e2e\.result == 'success'/)
  assert.match(finalizerSource, /needs\['test-ssr-edge'\]\.result == 'success'/)
  assert.match(finalizerSource, /name: compiler-rollout-raw-evidence/)
  assert.match(finalizerSource, /name: Bind required workflow job results/)
  assert.match(finalizerSource, /COMPILER_ROLLOUT_NEEDS: \$\{\{ toJSON\(needs\) \}\}/)
  assert.match(finalizerSource, /compiler-rollout-workflow-gate\.mjs/)
  assert.match(finalizerSource, /name: Seal candidate evidence/)
  assert.match(finalizerSource, /name: compiler-rollout-candidate/)
  assert.doesNotMatch(finalizerSource, /Upload finalized rollout candidate\n\s+if: always\(\)/)
})

test('browser E2E continuously includes production-shaped real applications and scheduled soak', () => {
  assert.match(rootPackage.scripts['test:e2e'], /pnpm test:real-apps/)
  assert.match(rootPackage.scripts['test:real-apps'], /examples:build-real-apps/)
  assert.match(rootPackage.scripts['test:real-apps'], /playwright\.config\.ts/)
  assert.match(ciWorkflow, /FICT_REAL_APP_SOAK_MS/)
  assert.match(ciWorkflow, /180000/)
})

test('browser E2E failures retain annotations, reports, and retry traces', () => {
  const fictPackage = JSON.parse(
    readFileSync(new URL('../packages/fict/package.json', import.meta.url), 'utf8'),
  )
  const browserConfig = readFileSync(
    new URL('../packages/fict/playwright.config.ts', import.meta.url),
    'utf8',
  )
  const realAppsConfig = readFileSync(
    new URL('../examples/real-apps/playwright.config.ts', import.meta.url),
    'utf8',
  )

  assert.doesNotMatch(fictPackage.scripts['test:e2e'], /--reporter/)
  assert.doesNotMatch(rootPackage.scripts['test:real-apps'], /--reporter/)
  for (const config of [browserConfig, realAppsConfig]) {
    assert.match(config, /process\.env\.GITHUB_ACTIONS/)
    assert.match(config, /\['github'\]/)
    assert.match(config, /\['html', \{ open: 'never' \}\]/)
    assert.match(config, /trace: 'on-first-retry'/)
  }

  assert.match(ciWorkflow, /name: Run browser and real-application E2E\n\s+id: e2e/)
  assert.match(ciWorkflow, /name: Upload E2E failure diagnostics/)
  assert.match(ciWorkflow, /if: steps\.e2e\.outcome == 'failure'/)
  assert.match(ciWorkflow, /packages\/fict\/playwright-report/)
  assert.match(ciWorkflow, /packages\/fict\/test-results/)
  assert.match(ciWorkflow, /examples\/real-apps\/playwright-report/)
  assert.match(ciWorkflow, /examples\/real-apps\/test-results/)
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
