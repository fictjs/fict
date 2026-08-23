import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
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
  writeViteRustIsolationConsumer,
} from './package-tarball-smoke.mjs'
import {
  dirtyCheckoutMessage,
  pnpmStoreRoot,
  releaseIsolationEnv,
  worktreeRemovalFailure,
} from './release-verify-clean.mjs'
import { isolatedNpmEnvironment } from './lib/npm-smoke-environment.mjs'

const rootPackage = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const compilerPackage = JSON.parse(
  readFileSync(new URL('../packages/compiler/package.json', import.meta.url), 'utf8'),
)
const compilerCapabilities = JSON.parse(
  readFileSync(new URL('../packages/compiler/compiler-capabilities.json', import.meta.url), 'utf8'),
)
const rolloutState = JSON.parse(
  readFileSync(new URL('../.github/compiler-rollout-state.json', import.meta.url), 'utf8'),
)
const rolloutReview = JSON.parse(
  readFileSync(new URL('../.github/compiler-rollout-review.json', import.meta.url), 'utf8'),
)
const legacyRemovalReview = JSON.parse(
  readFileSync(new URL('../.github/compiler-legacy-removal-review.json', import.meta.url), 'utf8'),
)
const rolloutEvidence = JSON.parse(
  readFileSync(new URL('../.github/compiler-rollout-evidence.json', import.meta.url), 'utf8'),
)
const legacyRemovalEvidence = JSON.parse(
  readFileSync(
    new URL('../.github/compiler-legacy-removal-evidence.json', import.meta.url),
    'utf8',
  ),
)
const nativeCertification = JSON.parse(
  readFileSync(
    new URL(`../${rolloutState.rustDefaultNativeCertificationPath}`, import.meta.url),
    'utf8',
  ),
)
const rolloutReadiness = readFileSync(
  new URL('./compiler-rollout-readiness.mjs', import.meta.url),
  'utf8',
)
const releaseWorkflow = readFileSync(
  new URL('../.github/workflows/release.yml', import.meta.url),
  'utf8',
)
const gitAttributes = readFileSync(new URL('../.gitattributes', import.meta.url), 'utf8')
const gitIgnore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8')
const zigRequirements = readFileSync(
  new URL('../.github/requirements-zig-linux.txt', import.meta.url),
  'utf8',
)
const ciWorkflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
const workflowsDirectory = new URL('../.github/workflows/', import.meta.url)
const workflowSources = readdirSync(workflowsDirectory)
  .filter(file => file.endsWith('.yml') || file.endsWith('.yaml'))
  .map(file => [file, readFileSync(new URL(file, workflowsDirectory), 'utf8')])
const reviewedActionPins = new Map([
  [
    'actions/attest',
    { sha: '1e69f48acb82d1966a394da916b4c1698aa569d6', version: 'v4.2.2', minimumMajor: 4 },
  ],
  [
    'actions/cache',
    { sha: 'caa296126883cff596d87d8935842f9db880ef25', version: 'v5.1.0', minimumMajor: 5 },
  ],
  [
    'actions/checkout',
    { sha: 'fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09', version: 'v5.1.0', minimumMajor: 5 },
  ],
  [
    'actions/download-artifact',
    { sha: '37930b1c2abaa49bbe596cd826c3c89aef350131', version: 'v7.0.0', minimumMajor: 7 },
  ],
  [
    'actions/setup-node',
    { sha: 'a0853c24544627f65ddf259abe73b1d18a591444', version: 'v5.0.0', minimumMajor: 5 },
  ],
  [
    'actions/upload-artifact',
    { sha: 'b7c566a772e6b6bfb58ed0dc250532a479d7789f', version: 'v6.0.0', minimumMajor: 6 },
  ],
  [
    'codecov/codecov-action',
    { sha: 'fb8b3582c8e4def4969c97caa2f19720cb33a72f', version: 'v6.0.2', minimumMajor: 6 },
  ],
  [
    'pnpm/action-setup',
    { sha: 'fc06bc1257f339d1d5d8b3a19a8cae5388b55320', version: 'v5.0.0', minimumMajor: 5 },
  ],
])
const realAppE2eRunner = readFileSync(new URL('./run-real-app-e2e.mjs', import.meta.url), 'utf8')
const productionAudit = readFileSync(
  new URL('./audit-production-dependencies.mjs', import.meta.url),
  'utf8',
)
const turboConfig = JSON.parse(readFileSync(new URL('../turbo.json', import.meta.url), 'utf8'))
const ssrPackage = JSON.parse(
  readFileSync(new URL('../packages/ssr/package.json', import.meta.url), 'utf8'),
)

test('release verification retains regression, tarball, SSR, browser, and clean-checkout gates', () => {
  assert.deepEqual(verifyReleaseContract(rootPackage, releaseWorkflow), [])
})

test('tarball Vite smoke binds the compiler capability version into its generated consumer', t => {
  const tempDirectory = mkdtempSync(path.join(os.tmpdir(), 'fict-vite-tarball-consumer-'))
  t.after(() => rmSync(tempDirectory, { recursive: true, force: true }))
  const consumerPath = path.join(tempDirectory, 'consumer.cjs')
  writeViteRustIsolationConsumer(consumerPath)
  const consumer = readFileSync(consumerPath, 'utf8')

  assert.match(
    consumer,
    new RegExp(`compilerCapabilityManifestVersion: ${compilerCapabilities.schemaVersion},`),
  )
  assert.doesNotMatch(consumer, /^\s+compilerCapabilityManifestVersion,$/m)
  assert.match(consumer, /typeof error\.message === 'string'/)
})

test('CI validates the live compiler rollout state through the shared release preflight', () => {
  assert.match(ciWorkflow, /run: pnpm release:preflight/)
  assert.match(rootPackage.scripts['release:preflight'], /pnpm test:compiler:rollout-state/)
  assert.match(rootPackage.scripts['release:preflight'], /pnpm guardrails:compiler-capabilities/)
  assert.match(
    rootPackage.scripts['test:compiler:rollout-state'],
    /node scripts\/compiler-rollout-readiness\.mjs$/,
  )
})

test('normal CI typechecks the compiler fuzz target before the scheduled fuzz run', () => {
  assert.equal(
    rootPackage.scripts['test:compiler:fuzz-check'],
    'cargo check --manifest-path fuzz/Cargo.toml --locked --bins',
  )
  assert.match(
    ciWorkflow,
    /name: Typecheck compiler fuzz target on stable[\s\S]*?if: matrix\.node == '24'[\s\S]*?run: pnpm test:compiler:fuzz-check/,
  )
})

test('scheduled fuzz retains the HIR, public request, and structured provenance pipelines', () => {
  assert.match(ciWorkflow, /build compiler_pipeline/)
  assert.match(ciWorkflow, /build compiler_request_pipeline/)
  assert.match(ciWorkflow, /build state_provenance/)
  assert.match(
    ciWorkflow,
    /run compiler_pipeline --[\s\S]*?-max_total_time=600 -timeout=10 -rss_limit_mb=4096/,
  )
  assert.match(
    ciWorkflow,
    /run compiler_request_pipeline --[\s\S]*?-max_total_time=600 -timeout=10 -rss_limit_mb=4096/,
  )
  assert.match(
    ciWorkflow,
    /run state_provenance --[\s\S]*?-max_total_time=600 -timeout=10 -rss_limit_mb=4096/,
  )
})

test('release publishing uses one dependency-ordered publisher after native certification', () => {
  assert.match(releaseWorkflow, /name: Build native compiler packages/)
  assert.match(releaseWorkflow, /name: Certify native compiler packages/)
  assert.match(releaseWorkflow, /node scripts\/publish-release-packages\.mjs/)
  assert.match(releaseWorkflow, /name: Verify compiler release identity and frozen corpus/)
  assert.match(releaseWorkflow, /node scripts\/verify-compiler-release-unit\.mjs/)
  assert.match(releaseWorkflow, /--revision "\$\{GITHUB_SHA\}"/)
  const compilerIdentityGate = releaseWorkflow.indexOf(
    'name: Verify compiler release identity and frozen corpus',
  )
  const packagePublisher = releaseWorkflow.indexOf(
    'name: Preflight and publish the dependency-ordered release set',
  )
  assert.ok(compilerIdentityGate >= 0 && compilerIdentityGate < packagePublisher)
  assert.doesNotMatch(releaseWorkflow, /changeset publish/)
  assert.equal(rootPackage.scripts.release, 'pnpm release:plan --require-existing-packages')
})

test('release preflight blocks native fanout on release identity drift', () => {
  const preflightStart = releaseWorkflow.indexOf('\n  release-preflight:')
  const nativeMatrixStart = releaseWorkflow.indexOf('\n  native-matrix:')
  const nativeBuildStart = releaseWorkflow.indexOf('\n  native-build:')
  const preflightSource = releaseWorkflow.slice(preflightStart, nativeMatrixStart)
  const nativeMatrixSource = releaseWorkflow.slice(nativeMatrixStart, nativeBuildStart)

  assert.ok(preflightStart >= 0 && preflightStart < nativeMatrixStart)
  assert.match(preflightSource, /fetch-depth: 0/)
  assert.match(preflightSource, /pnpm install --frozen-lockfile/)
  assert.match(preflightSource, /name: Verify release contracts before native fanout/)
  assert.match(preflightSource, /run: pnpm release:preflight/)
  assert.match(
    preflightSource,
    /name: Verify tagged release identity[\s\S]*?if: github\.event_name == 'push'[\s\S]*?pnpm release:plan --offline --tag "\$\{GITHUB_REF_NAME\}"/,
  )
  assert.match(nativeMatrixSource, /needs: release-preflight/)
  assert.match(rootPackage.scripts.precommit, /pnpm release:preflight/)
  assert.match(rootPackage.scripts['release:preflight'], /pnpm test:release-publish-plan/)
  assert.match(rootPackage.scripts['release:preflight'], /pnpm test:release-verification/)
  assert.match(rootPackage.scripts['release:preflight'], /pnpm guardrails:metadata-protocol/)
})

test('tag publishing creates an evidence-bound idempotent GitHub Release after npm', () => {
  const releaseJob = releaseWorkflow.indexOf('\n  release:')
  const packagePublisher = releaseWorkflow.indexOf(
    'name: Preflight and publish the dependency-ordered release set',
  )
  const githubRelease = releaseWorkflow.indexOf('name: Publish or verify GitHub Release')
  assert.ok(releaseJob >= 0 && releaseJob < packagePublisher)
  assert.ok(packagePublisher < githubRelease)

  const releaseSource = releaseWorkflow.slice(releaseJob)
  assert.match(releaseSource, /permissions:\n\s+contents: write\n\s+id-token: write/)
  assert.match(releaseSource, /name: Download native release certification/)
  assert.match(releaseSource, /name: fict-native-certification-\$\{\{ github\.sha \}\}/)
  assert.match(releaseSource, /git rev-list -n 1 "\$\{GITHUB_REF_NAME\}"/)
  assert.match(releaseSource, /test "\$\{tag_revision\}" = "\$\{GITHUB_SHA\}"/)
  assert.match(releaseSource, /native-certification\.json/)
  assert.match(releaseSource, /npm-publish-plan\.json/)
  assert.match(releaseSource, /release-artifacts\.json/)
  assert.match(releaseSource, /gh release view/)
  assert.match(releaseSource, /gh release upload[\s\S]*?--clobber/)
  assert.match(releaseSource, /gh release create[\s\S]*?--verify-tag[\s\S]*?--generate-notes/)
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
      /test "\$\(cargo-audit --version\)" = "cargo-audit \$\{CARGO_AUDIT_VERSION\}"/,
    )
    assert.doesNotMatch(workflow, /test "\$\(cargo audit --version\)"/)
    assert.doesNotMatch(workflow, /cargo audit[^\n]*--ignore/)
  }

  assert.match(ciWorkflow, /name: Audit locked Rust dependencies[\s\S]*?pnpm security:audit:rust/)
  assert.match(releaseWorkflow, /^\s+cargo audit --deny warnings$/m)
  assert.match(releaseWorkflow, /^\s+cargo audit --deny warnings --file fuzz\/Cargo\.lock$/m)
})

test('production audit uses the supported npm bulk advisory endpoint', () => {
  assert.equal(
    rootPackage.scripts['security:audit:prod'],
    'node --test scripts/audit-production-dependencies.test.mjs && node scripts/audit-production-dependencies.mjs',
  )
  assert.match(productionAudit, /\/security\/advisories\/bulk/)
  assert.doesNotMatch(rootPackage.scripts['security:audit:prod'], /pnpm audit/)
  assert.match(ciWorkflow, /run: pnpm security:audit:prod/)
  assert.match(
    rootPackage.scripts['release:verify'],
    /^pnpm security:audit:prod && pnpm security:audit:rust &&/,
  )
})

test('CI and release pin reviewed Node 24-compatible actions to full commit SHAs', () => {
  const seen = new Set()

  for (const [workflowName, workflow] of workflowSources) {
    const usesLines = workflow.match(/^\s*(?:-\s+)?uses:\s+.*$/gm) ?? []
    for (const line of usesLines) {
      const match = /^\s*(?:-\s+)?uses:\s+([^\s#]+)(?:\s+#\s*(.+?))?\s*$/.exec(line)
      assert.ok(match, `${workflowName} contains a malformed action reference: ${line.trim()}`)
      const [, actionReference, version] = match
      if (actionReference.startsWith('./')) continue
      const separator = actionReference.lastIndexOf('@')
      assert.ok(separator > 0, `${workflowName} action must include an immutable reference`)
      const action = actionReference.slice(0, separator)
      const sha = actionReference.slice(separator + 1)
      const expected = reviewedActionPins.get(action)
      assert.ok(expected, `${workflowName} uses unreviewed external action ${action}`)
      assert.match(sha, /^[a-f0-9]{40}$/, `${action} must use a full lowercase commit SHA`)
      assert.equal(sha, expected.sha, `${action} must use its reviewed commit`)
      assert.equal(version, expected.version, `${action} must retain its exact version comment`)
      const major = Number(/^v(\d+)/.exec(version)?.[1])
      seen.add(action)
      assert.ok(
        major >= expected.minimumMajor,
        `${action}@${version} must use Node 24-compatible major v${expected.minimumMajor} or newer`,
      )
    }
  }

  assert.deepEqual([...seen].sort(), [...reviewedActionPins.keys()].sort())
})

test('musl native releases use a pinned Zig cdylib build path', () => {
  const nativeBuildStart = releaseWorkflow.indexOf('\n  native-build:')
  const nativeRuntimeStart = releaseWorkflow.indexOf('\n  native-runtime:')
  assert.ok(nativeBuildStart >= 0 && nativeBuildStart < nativeRuntimeStart)

  const nativeBuild = releaseWorkflow.slice(nativeBuildStart, nativeRuntimeStart)
  assert.match(releaseWorkflow, /^  CARGO_ZIGBUILD_VERSION: 0\.23\.0$/m)
  assert.match(releaseWorkflow, /^  ZIG_VERSION: 0\.14\.1$/m)
  assert.match(
    zigRequirements,
    /^ziglang==0\.14\.1 \\\n\s+--hash=sha256:[a-f0-9]{64} \\\n\s+--hash=sha256:[a-f0-9]{64}\n$/,
  )
  assert.match(
    nativeBuild,
    /python3 -m venv "\$\{RUNNER_TEMP\}\/fict-zig"[\s\S]*?--require-hashes[\s\S]*?--requirement \.github\/requirements-zig-linux\.txt/,
  )
  assert.match(
    nativeBuild,
    /test "\$\("\$\{RUNNER_TEMP\}\/fict-zig\/bin\/python" -m ziglang version\)" = "\$\{ZIG_VERSION\}"/,
  )
  assert.match(nativeBuild, /path: ~\/\.cargo\/bin\/cargo-zigbuild/)
  assert.match(
    nativeBuild,
    /cargo install cargo-zigbuild --version "\$\{CARGO_ZIGBUILD_VERSION\}" --locked/,
  )
  assert.match(
    nativeBuild,
    /test "\$\(cargo-zigbuild --version\)" = "cargo-zigbuild \$\{CARGO_ZIGBUILD_VERSION\}"/,
  )
  assert.match(nativeBuild, /name: Build target N-API binary\n\s+if: \$\{\{ !matrix\.musl \}\}/)
  assert.match(
    nativeBuild,
    /name: Build target N-API binary with Zig[\s\S]*?CARGO_ZIGBUILD_PYTHON_PATH: \$\{\{ runner\.temp \}\}\/fict-zig\/bin\/python[\s\S]*?RUSTFLAGS: '-C target-feature=-crt-static'[\s\S]*?cargo zigbuild --release -p fict-compiler-napi --target \$\{\{ matrix\.rustTarget \}\}/,
  )
  assert.doesNotMatch(nativeBuild, /musl-tools|Install musl linker|mlugg\/setup-zig/)
})

test('native release artifacts carry revision-bound SBOM and Sigstore attestations', () => {
  const nativeBuildStart = releaseWorkflow.indexOf('\n  native-build:')
  const nativeRuntimeStart = releaseWorkflow.indexOf('\n  native-runtime:')
  const nativeCertificationStart = releaseWorkflow.indexOf('\n  native-certification:')
  const releaseStart = releaseWorkflow.indexOf('\n  release:')
  const nativeBuild = releaseWorkflow.slice(nativeBuildStart, nativeRuntimeStart)
  const nativeRuntime = releaseWorkflow.slice(nativeRuntimeStart, nativeCertificationStart)
  const nativeCertificationSource = releaseWorkflow.slice(nativeCertificationStart, releaseStart)
  const attestPin = reviewedActionPins.get('actions/attest')

  assert.match(nativeBuild, /permissions:[\s\S]*?artifact-metadata: write/)
  assert.match(nativeBuild, /permissions:[\s\S]*?attestations: write/)
  assert.match(nativeBuild, /permissions:[\s\S]*?id-token: write/)
  assert.equal(
    (
      nativeBuild.match(
        new RegExp(`uses: actions/attest@${attestPin.sha} # ${attestPin.version}`, 'g'),
      ) ?? []
    ).length,
    2,
  )
  assert.match(nativeBuild, /bundle[\s\S]*?--revision \$\{\{ github\.sha \}\}/)
  assert.match(nativeBuild, /subject-path:[\s\S]*?fict_compiler_napi\.node[\s\S]*?\*\.tgz/)
  assert.match(nativeBuild, /sbom-path: .*fict-compiler-native\.spdx\.json/)
  assert.match(gitIgnore, /^packages\/compiler-\*\/fict-compiler-native\.spdx\.json$/m)
  assert.match(nativeBuild, /provenance\.attestation\.json/)
  assert.match(nativeBuild, /sbom\.attestation\.json/)
  assert.match(nativeBuild, /--attestations required[\s\S]*?--sbom-closure true/)
  assert.match(nativeRuntime, /--attestations required/)
  assert.match(nativeCertificationSource, /permissions:[\s\S]*?attestations: read/)
  assert.equal((nativeCertificationSource.match(/gh attestation verify/g) ?? []).length, 3)
  assert.equal(
    (nativeCertificationSource.match(/--predicate-type https:\/\/slsa\.dev\/provenance\/v1/g) ?? [])
      .length,
    2,
  )
  assert.match(nativeCertificationSource, /--predicate-type https:\/\/spdx\.dev\/Document\/v2\.3/)
  assert.match(
    nativeCertificationSource,
    /verify-runtime-evidence[\s\S]*?--attestations required[\s\S]*?--sbom-closure true/,
  )
})

test('native bundler typechecks wait for compiler declarations in clean checkouts', () => {
  for (const task of ['@fictjs/vite-plugin#typecheck', '@fictjs/webpack-plugin#typecheck']) {
    assert.deepEqual(turboConfig.tasks[task]?.dependsOn, ['@fictjs/compiler#build'])
  }
})

test('CI and release verification share the complete pinned Rust workspace gate', () => {
  assert.equal(
    rootPackage.scripts['verify:rust-workspace'],
    'cargo fmt --all --check && cargo clippy --workspace --all-targets --all-features -- -D warnings && cargo test --workspace --all-features && pnpm guardrails:rust-crates',
  )
  assert.match(rootPackage.scripts['release:verify'], /pnpm release:compiler:verify/)
  assert.match(rootPackage.scripts['release:compiler:verify'], /pnpm verify:rust-workspace/)
  assert.match(rootPackage.scripts['release:verify'], /pnpm guardrails:rust-crates/)
  assert.match(
    ciWorkflow,
    /name: Verify pinned Rust workspace[\s\S]*?^\s+pnpm verify:rust-workspace$/m,
  )
  assert.doesNotMatch(ciWorkflow, /^\s+cargo clippy --workspace/m)
})

test('controlled native builds embed the workflow source revision', () => {
  const revisionBinding = /FICT_COMPILER_BUILD_REVISION: \$\{\{ github\.sha \}\}/
  assert.match(ciWorkflow, revisionBinding)
  assert.match(releaseWorkflow, revisionBinding)
})

test('compiler review ancestry fails before the native release fanout', () => {
  const nativeMatrixStart = releaseWorkflow.indexOf('\n  native-matrix:')
  const nativeBuildStart = releaseWorkflow.indexOf('\n  native-build:')
  const nativeMatrixSource = releaseWorkflow.slice(nativeMatrixStart, nativeBuildStart)
  const reviewGate = nativeMatrixSource.indexOf('name: Verify frozen compiler review ancestry')
  const dependencyAudit = nativeMatrixSource.indexOf('name: Audit locked Rust dependencies')

  assert.ok(nativeMatrixStart >= 0 && nativeMatrixStart < nativeBuildStart)
  assert.match(nativeMatrixSource, /fetch-depth: 0/)
  assert.match(nativeMatrixSource, /FICT_REVIEW_TARGET_REVISION: \$\{\{ github\.sha \}\}/)
  assert.match(nativeMatrixSource, /node --test scripts\/compiler-review-provenance\.test\.mjs/)
  assert.ok(reviewGate >= 0 && reviewGate < dependencyAudit)
  assert.match(
    rootPackage.scripts['test:release-publish-plan'],
    /compiler-review-provenance\.test\.mjs/,
  )

  const lintStart = ciWorkflow.indexOf('\n  lint:')
  const typecheckStart = ciWorkflow.indexOf('\n  typecheck:')
  const lintSource = ciWorkflow.slice(lintStart, typecheckStart)
  assert.match(lintSource, /fetch-depth: 0/)
  assert.match(lintSource, /pnpm release:preflight/)
  assert.match(rootPackage.scripts['release:preflight'], /pnpm test:release-publish-plan/)
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
  const pnpmPin = reviewedActionPins.get('pnpm/action-setup')
  const nodePin = reviewedActionPins.get('actions/setup-node')
  const certificationPnpmSetup = certificationSource.indexOf(
    `uses: pnpm/action-setup@${pnpmPin.sha} # ${pnpmPin.version}`,
  )
  const certificationNodeSetup = certificationSource.indexOf(
    `uses: actions/setup-node@${nodePin.sha} # ${nodePin.version}`,
  )
  assert.match(certificationSource, /needs: \[native-build, native-runtime\]/)
  assert.doesNotMatch(certificationSource, /github\.event_name == 'push'/)
  assert.ok(certificationPnpmSetup >= 0 && certificationPnpmSetup < certificationNodeSetup)
  assert.match(
    certificationSource,
    new RegExp(`uses: pnpm/action-setup@${pnpmPin.sha}[^\\n]*[\\s\\S]*?version: 9\\.1\\.1`),
  )
  assert.match(releaseSource, /needs: native-certification/)
  assert.doesNotMatch(releaseSource, /Download all native runtime evidence/)
})

test('native certification hashes one byte-identical frozen corpus on every runner', () => {
  const corpusPath = 'crates/fict-compiler/tests/rust_frozen_codegen_corpus.json'
  const corpusRules = gitAttributes.split(/\r?\n/).filter(line => line.startsWith(`${corpusPath} `))

  assert.deepEqual(corpusRules, [`${corpusPath} text eol=lf`])
})

test('native release installs keep the tracked Husky stub clean on Windows', () => {
  const huskyStubPath = '.husky/_/husky.sh'
  const huskyStubRules = gitAttributes
    .split(/\r?\n/)
    .filter(line => line.startsWith(`${huskyStubPath} `))

  assert.deepEqual(huskyStubRules, [`${huskyStubPath} text eol=lf`])
})

test('Rust-default approval binds the complete native certification to its candidate', () => {
  assert.equal(rolloutState.schemaVersion, 5)
  assert.equal(
    rolloutState.rustDefaultNativeCertificationPath,
    `.github/compiler-native-certifications/v${nativeCertification.packageVersion}-${nativeCertification.compilerBuildRevision}.json`,
  )
  assert.notEqual(nativeCertification.packageVersion, compilerPackage.version)
  assert.equal(
    rolloutState.legacyRemovalEvidencePath,
    '.github/compiler-legacy-removal-evidence.json',
  )
  assert.equal(rolloutReview.schemaVersion, 3)
  assert.equal(rolloutReview.status, 'approved')
  assert.equal(rolloutReview.candidateDigest, rolloutEvidence.candidateDigest)
  assert.equal(rolloutReview.nativeCertificationDigest, nativeCertification.certificationDigest)
  assert.match(
    rolloutReadiness,
    /assertRustDefaultNativeCertification\(nativeCertification, evidence\)/,
  )
  assert.match(rolloutReadiness, /payload\.compilerBuildRevision !== evidence\.sourceRevision/)
  assert.match(rolloutReadiness, /payload\.compilerBuildId !== evidence\.compilerBuildId/)
  assert.match(
    rolloutReadiness,
    /review\.nativeCertificationDigest !== nativeCertification\.certificationDigest/,
  )
})

test('legacy-removal approval binds the final release window and evidence digest', () => {
  assert.equal(rolloutState.phase, 'legacy-removal')
  assert.equal(rolloutState.rollbackBackend, 'rust')
  assert.equal(legacyRemovalEvidence.schemaVersion, 1)
  assert.equal(legacyRemovalEvidence.status, 'pass')
  assert.equal(legacyRemovalReview.schemaVersion, 2)
  assert.equal(legacyRemovalReview.status, 'approved')
  assert.ok(legacyRemovalReview.reviewer)
  assert.equal(legacyRemovalReview.evidenceDigest, legacyRemovalEvidence.evidenceDigest)
  for (const field of [
    'rustDefaultRelease',
    'compatibilityRelease',
    'finalLegacyRelease',
    'legacyRemovalRelease',
  ]) {
    assert.equal(legacyRemovalEvidence[field], rolloutState[field])
    assert.equal(legacyRemovalReview[field], rolloutState[field])
  }
  assert.ok(Object.values(legacyRemovalReview.areas).every(Boolean))
  assert.equal(legacyRemovalEvidence.publishedReleases.rustDefault.version, '0.29.0')
  assert.equal(legacyRemovalEvidence.publishedReleases.compatibility.version, '0.30.0')
  assert.equal(legacyRemovalEvidence.publishedReleases.finalLegacy.version, '0.30.1')
  assert.equal(
    rootPackage.scripts['release:evidence:compiler'],
    'node scripts/compiler-release-evidence.mjs',
  )
  assert.match(
    rootPackage.scripts['test:release-verification'],
    /compiler-release-evidence\.test\.mjs/,
  )
  assert.match(rolloutReadiness, /assertLegacyRemovalEvidenceDocumentShape/)
  assert.match(rolloutReadiness, /review\.evidenceDigest !== evidence\.evidenceDigest/)
})

test('browser E2E includes native Vite HMR, production-shaped applications, and scheduled soak', () => {
  assert.match(rootPackage.scripts['test:e2e'], /pnpm test:vite:hmr:e2e/)
  assert.equal(rootPackage.scripts['test:vite:hmr:e2e'], 'node scripts/native-vite-hmr-e2e.mjs')
  assert.match(rootPackage.scripts['test:e2e'], /pnpm test:real-apps/)
  assert.match(rootPackage.scripts['test:real-apps'], /examples:build-real-apps/)
  assert.match(rootPackage.scripts['test:real-apps'], /run-real-app-e2e\.mjs/)
  assert.match(realAppE2eRunner, /examples\/real-apps\/playwright\.config\.ts/)
  assert.match(ciWorkflow, /FICT_REAL_APP_SOAK_MS/)
  assert.match(ciWorkflow, /180000/)
})

test('real-app E2E reserves per-run ports and preserves web-server startup output', () => {
  const realAppsConfig = readFileSync(
    new URL('../examples/real-apps/playwright.config.ts', import.meta.url),
    'utf8',
  )

  assert.match(realAppE2eRunner, /reserveRealAppPorts/)
  assert.match(realAppE2eRunner, /FICT_REAL_APP_OPERATIONS_PORT/)
  assert.match(realAppE2eRunner, /FICT_REAL_APP_RESUMABLE_SSR_PORT/)
  assert.match(realAppE2eRunner, /FICT_REAL_APP_STREAMING_SSR_PORT/)
  assert.match(realAppsConfig, /stdout: 'pipe'/)
  assert.match(realAppsConfig, /stderr: 'pipe'/)
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
  assert.match(ciWorkflow, /if: failure\(\) && steps\.e2e\.outcome == 'failure'/)
  assert.match(ciWorkflow, /packages\/fict\/playwright-report/)
  assert.match(ciWorkflow, /packages\/fict\/test-results/)
  assert.match(ciWorkflow, /examples\/real-apps\/playwright-report/)
  assert.match(ciWorkflow, /examples\/real-apps\/test-results/)
  assert.match(ciWorkflow, /test-results\/native-vite-hmr/)
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

test('native npm smoke installs ignore user-scoped script policy', () => {
  const baseEnvironment = {
    PATH: '/usr/bin',
    npm_config_userconfig: '/tmp/user-npmrc',
    NPM_CONFIG_ALLOW_SCRIPTS: 'fict-monorepo',
  }

  assert.deepEqual(isolatedNpmEnvironment(baseEnvironment, '/tmp/smoke-npmrc'), {
    PATH: '/usr/bin',
    NPM_CONFIG_USERCONFIG: '/tmp/smoke-npmrc',
  })
  assert.equal(baseEnvironment.npm_config_userconfig, '/tmp/user-npmrc')
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
  assert.deepEqual(releaseIsolationEnv('/tmp/fict-clean', '/cache/pnpm', {}), {
    CI: 'true',
    FICT_PNPM_STORE_DIR: '/cache/pnpm',
    HUSKY: '0',
    NO_PROXY: 'localhost,127.0.0.1,::1',
    TURBO_CACHE_DIR: '/tmp/fict-clean/.turbo/release-cache',
    no_proxy: 'localhost,127.0.0.1,::1',
  })
})

test('clean checkout preserves proxy exclusions while bypassing local browser servers', () => {
  const environment = {
    NO_PROXY: 'registry.npmjs.org,localhost',
    no_proxy: 'internal.example,127.0.0.1',
  }

  assert.deepEqual(releaseIsolationEnv('/tmp/fict-clean', '/cache/pnpm', environment), {
    CI: 'true',
    FICT_PNPM_STORE_DIR: '/cache/pnpm',
    HUSKY: '0',
    NO_PROXY: 'registry.npmjs.org,localhost,internal.example,127.0.0.1,::1',
    TURBO_CACHE_DIR: '/tmp/fict-clean/.turbo/release-cache',
    no_proxy: 'registry.npmjs.org,localhost,internal.example,127.0.0.1,::1',
  })
})

test('clean checkout fails when its temporary worktree cannot be removed', () => {
  assert.equal(worktreeRemovalFailure(0, '/tmp/fict-clean'), null)
  assert.equal(
    worktreeRemovalFailure(128, '/tmp/fict-clean'),
    '[release-verify-clean] Failed to remove temporary worktree /tmp/fict-clean',
  )
})
