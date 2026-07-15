import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { validateCompilerRolloutReadiness } from './compiler-rollout-readiness.mjs'
import { REQUIRED_ROLLOUT_JOBS } from './compiler-rollout-workflow-contract.mjs'
import { NATIVE_COMPILER_NODE_LANES, NATIVE_COMPILER_TARGETS } from './native-compiler-packages.mjs'

const readinessScript = fileURLToPath(new URL('./compiler-rollout-readiness.mjs', import.meta.url))
const migrationGuidanceContent = '# Rust-only compiler migration\n'

const approvedAreas = {
  coreSemantics: true,
  strictGuarantee: true,
  typescriptNamespacesAndCts: true,
  runtimeAndMetadataAbi: true,
  sourceMaps: true,
  nativePlatformsAndRelease: true,
  nativePackageSizeBudget: true,
  performanceAndRss: true,
  rollbackDrill: true,
}
const approvedRemovalAreas = {
  replacementAvailability: true,
  migrationGuidance: true,
  candidateAndRollbackEvidence: true,
  rustDefaultPublished: true,
  subsequentMinorCompleted: true,
  finalPresetPublished: true,
  coreScopeChanges: true,
  legacyDependencyRemoval: true,
}

function pendingReview() {
  return {
    schemaVersion: 3,
    status: 'pending',
    candidateDigest: null,
    nativeCertificationDigest: null,
    reviewer: null,
    areas: Object.fromEntries(Object.keys(approvedAreas).map(area => [area, false])),
  }
}

function pendingRemovalReview() {
  return {
    schemaVersion: 2,
    status: 'pending',
    reviewer: null,
    evidenceDigest: null,
    rustDefaultRelease: null,
    compatibilityRelease: null,
    finalLegacyRelease: null,
    legacyRemovalRelease: null,
    areas: Object.fromEntries(Object.keys(approvedRemovalAreas).map(area => [area, false])),
  }
}

function pendingRemovalEvidence() {
  return { schemaVersion: 1, status: 'pending', evidenceDigest: null }
}

function publishedReleaseEvidence(version, index) {
  return {
    version,
    tag: `v${version}`,
    commitSha: index.toString(16).repeat(40),
    workflowRunId: String(100 + index),
    githubRelease: {
      id: 1_000 + index,
      url: `https://github.com/fictjs/fict/releases/tag/v${version}`,
      assets: ['native-certification.json', 'npm-publish-plan.json', 'release-artifacts.json'].map(
        (name, assetIndex) => ({
          name,
          id: index * 10 + assetIndex + 1,
          digest: `sha256:${String(index + assetIndex)
            .repeat(64)
            .slice(0, 64)}`,
        }),
      ),
    },
    npm: {
      packageName: '@fictjs/compiler',
      version,
      integrity: 'sha512-QUJDRA==',
      provenance: true,
    },
  }
}

function legacyRemovalEvidence(state, overrides = {}) {
  const artifact = release => ({
    release,
    status: 'pass',
    evidenceDigest: `sha256:${'e'.repeat(64)}`,
  })
  const publishedReleases = {
    rustDefault: publishedReleaseEvidence(state.rustDefaultRelease, 1),
    compatibility: publishedReleaseEvidence(state.compatibilityRelease, 2),
    finalLegacy: publishedReleaseEvidence(state.finalLegacyRelease, 3),
  }
  const payload = {
    schemaVersion: 1,
    status: 'pass',
    rustDefaultRelease: state.rustDefaultRelease,
    compatibilityRelease: state.compatibilityRelease,
    finalLegacyRelease: state.finalLegacyRelease,
    legacyRemovalRelease: state.legacyRemovalRelease,
    publishedReleases,
    nativeCertification: {
      release: state.finalLegacyRelease,
      workflowRunId: publishedReleases.finalLegacy.workflowRunId,
      sourceRevision: publishedReleases.finalLegacy.commitSha,
      certificationDigest: `sha256:${'b'.repeat(64)}`,
      targets: NATIVE_COMPILER_TARGETS.length,
      nodeLanes: [...NATIVE_COMPILER_NODE_LANES],
      certifications: NATIVE_COMPILER_TARGETS.length * NATIVE_COMPILER_NODE_LANES.length,
    },
    consumerValidation: {
      release: state.compatibilityRelease,
      repository: 'https://github.com/fictjs/real-consumer',
      commitSha: 'c'.repeat(40),
      status: 'pass',
      evidenceDigest: `sha256:${'d'.repeat(64)}`,
    },
    rollbackDrill: artifact(state.finalLegacyRelease),
    sourceMaps: artifact(state.finalLegacyRelease),
    performanceAndRss: artifact(state.finalLegacyRelease),
    migrationGuidance: {
      path: 'docs/compiler-rust-only-migration.md',
      digest: `sha256:${createHash('sha256').update(migrationGuidanceContent).digest('hex')}`,
    },
    finalPreset: {
      packageName: '@fictjs/babel-preset',
      version: state.finalLegacyRelease,
      integrity: 'sha512-QUJDRA==',
      provenance: true,
    },
    ...overrides,
  }
  return {
    ...payload,
    evidenceDigest: `sha256:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`,
  }
}

function approvedRemovalReview(state, evidence, overrides = {}) {
  return {
    schemaVersion: 2,
    status: 'approved',
    reviewer: 'release-maintainer',
    evidenceDigest: evidence.evidenceDigest,
    rustDefaultRelease: state.rustDefaultRelease,
    compatibilityRelease: state.compatibilityRelease,
    finalLegacyRelease: state.finalLegacyRelease,
    legacyRemovalRelease: state.legacyRemovalRelease,
    areas: approvedRemovalAreas,
    ...overrides,
  }
}

function rustDefaultState(overrides = {}) {
  return {
    phase: 'rust-default',
    viteDefaultBackend: 'rust',
    rustDefaultRelease: '0.29.0',
    ...overrides,
  }
}

function candidateEvidence(overrides = {}) {
  const {
    workflowGate: workflowGateOverride,
    workflowGateDigest: workflowGateDigestOverride,
    ...payloadOverrides
  } = overrides
  const artifactDigest = `sha256:${'b'.repeat(64)}`
  const identity = {
    schemaVersion: 5,
    status: 'pass',
    runId: '101',
    runAttempt: '1',
    sourceRevision: 'c'.repeat(40),
    compilerBuildRevision: 'c'.repeat(40),
    workflowEvent: 'push',
    sourceRef: 'refs/heads/main',
    promotionEligible: true,
    compilerBuildId: 'fict-rust-test',
    shadowDigest: artifactDigest,
    benchmarkDigest: artifactDigest,
    runtimeDigest: artifactDigest,
    rollbackDigest: artifactDigest,
    nativePackageDigest: artifactDigest,
    previousCandidateDigest: `sha256:${'d'.repeat(64)}`,
    consecutiveGreenCandidates: 2,
    ...payloadOverrides,
  }
  const workflowGate = workflowGateOverride ?? {
    schemaVersion: 1,
    status: 'pass',
    repository: 'fictjs/fict',
    workflowName: 'CI',
    workflowJob: 'compiler-rollout-finalize',
    runId: identity.runId,
    runAttempt: identity.runAttempt,
    sourceRevision: identity.sourceRevision,
    workflowEvent: identity.workflowEvent,
    sourceRef: identity.sourceRef,
    jobs: Object.fromEntries(
      REQUIRED_ROLLOUT_JOBS.map(job => [job, job === 'rust-fuzz' ? 'skipped' : 'success']),
    ),
  }
  const payload = {
    ...identity,
    workflowGate,
    workflowGateDigest:
      workflowGateDigestOverride ??
      `sha256:${createHash('sha256').update(JSON.stringify(workflowGate)).digest('hex')}`,
  }
  return {
    ...payload,
    candidateDigest: `sha256:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`,
  }
}

function nativeCertification(evidence, overrides = {}) {
  const releaseBundles = NATIVE_COMPILER_TARGETS.map((target, index) => {
    const tarballBytes = 1_000 + index
    const unpackedBytes = 2_000 + index
    return {
      target: target.target,
      packageVersion: '0.28.0',
      binarySha256: (index + 1).toString(16).repeat(64),
      tarballSha256: (index + 8).toString(16).slice(-1).repeat(64),
      tarballBytes,
      unpackedBytes,
      sizeGate: {
        schemaVersion: 1,
        target: target.target,
        profile: 'ci',
        tarballBytes,
        unpackedBytes,
        maximumTarballBytes: 10_000,
        maximumUnpackedBytes: 20_000,
        passed: true,
        violations: [],
      },
    }
  })
  const payload = {
    schemaVersion: 2,
    status: 'pass',
    targets: NATIVE_COMPILER_TARGETS.length,
    nodeLanes: [...NATIVE_COMPILER_NODE_LANES],
    certifications: NATIVE_COMPILER_TARGETS.length * NATIVE_COMPILER_NODE_LANES.length,
    bundles: NATIVE_COMPILER_TARGETS.length,
    certifiedPairs: NATIVE_COMPILER_TARGETS.flatMap(target =>
      NATIVE_COMPILER_NODE_LANES.map(nodeLane => `${target.target}:node-${nodeLane}`),
    ),
    runtimeEvidence: NATIVE_COMPILER_TARGETS.flatMap(target =>
      NATIVE_COMPILER_NODE_LANES.map(nodeLane => {
        const pair = `${target.target}:node-${nodeLane}`
        return {
          pair,
          target: target.target,
          nodeLane,
          node: nodeLane === '22.18.0' ? 'v22.18.0' : 'v24.7.0',
          evidenceDigest: `sha256:${createHash('sha256').update(pair).digest('hex')}`,
        }
      }),
    ),
    releaseBundles,
    packageVersion: '0.28.0',
    compilerBuildId: evidence.compilerBuildId,
    compilerBuildRevision: evidence.sourceRevision,
    ...overrides,
  }
  return {
    ...payload,
    certificationDigest: `sha256:${createHash('sha256')
      .update(JSON.stringify(payload))
      .digest('hex')}`,
  }
}

function approvedReview(evidence, overrides = {}) {
  return {
    schemaVersion: 3,
    status: 'approved',
    candidateDigest: evidence.candidateDigest,
    nativeCertificationDigest: nativeCertification(evidence).certificationDigest,
    reviewer: 'maintainer',
    areas: approvedAreas,
    ...overrides,
  }
}

async function fixture(
  state,
  review,
  evidence,
  removalReview,
  certificationOverride,
  removalEvidenceOverride,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fict-rollout-'))
  const certification =
    certificationOverride === undefined
      ? evidence
        ? nativeCertification(evidence)
        : null
      : certificationOverride
  await mkdir(path.join(root, '.github'), { recursive: true })
  await mkdir(path.join(root, 'docs'), { recursive: true })
  await mkdir(path.join(root, 'packages', 'compiler', 'src'), { recursive: true })
  await mkdir(path.join(root, 'packages', 'vite-plugin', 'src'), { recursive: true })
  await writeFile(
    path.join(root, '.github', 'compiler-rollout-state.json'),
    JSON.stringify({
      schemaVersion: 4,
      rollbackBackend: 'legacy',
      rustDefaultRelease: null,
      compatibilityRelease: null,
      finalLegacyRelease: null,
      legacyRemovalRelease: null,
      candidateEvidencePath: '.github/compiler-rollout-evidence.json',
      nativeCertificationPath: '.github/compiler-native-certification.json',
      reviewPath: '.github/compiler-rollout-review.json',
      legacyRemovalReviewPath: '.github/compiler-legacy-removal-review.json',
      legacyRemovalEvidencePath: '.github/compiler-legacy-removal-evidence.json',
      ...state,
    }),
  )
  await writeFile(
    path.join(root, 'packages', 'compiler', 'package.json'),
    JSON.stringify({ name: '@fictjs/compiler', exports: { '.': './dist/index.js' } }),
  )
  await writeFile(
    path.join(root, 'packages', 'compiler', 'src', 'index.ts'),
    state.phase === 'beta'
      ? "export { createFictPlugin as default } from './legacy-compiler'\nexport * from './legacy-compiler'"
      : "export { nativeCompilerInfo, transformSync, transform, scanSync, scan, analyzeSync, analyze } from './native-loader'",
  )
  await writeFile(
    path.join(root, 'packages', 'vite-plugin', 'src', 'index.ts'),
    state.phase === 'legacy-removal'
      ? 'const nativeCompiler = loadNativeCompilerBinding()'
      : `const backend = backendOption ?? backendFromEnvironment ?? '${state.viteDefaultBackend}'`,
  )
  await writeFile(
    path.join(root, '.github', 'compiler-rollout-review.json'),
    JSON.stringify(review ?? pendingReview()),
  )
  if (evidence) {
    await writeFile(
      path.join(root, '.github', 'compiler-rollout-evidence.json'),
      JSON.stringify(evidence),
    )
  }
  if (certification) {
    await writeFile(
      path.join(root, '.github', 'compiler-native-certification.json'),
      JSON.stringify(certification),
    )
  }
  await writeFile(
    path.join(root, '.github', 'compiler-legacy-removal-review.json'),
    JSON.stringify(removalReview ?? pendingRemovalReview()),
  )
  await writeFile(
    path.join(root, '.github', 'compiler-legacy-removal-evidence.json'),
    JSON.stringify(removalEvidenceOverride ?? pendingRemovalEvidence()),
  )
  await writeFile(
    path.join(root, 'docs', 'compiler-rust-only-migration.md'),
    migrationGuidanceContent,
  )
  return root
}

test('rollout readiness CLI rejects unknown arguments', () => {
  const result = spawnSync(process.execPath, [readinessScript, '--require-legacy-removal-ready'], {
    encoding: 'utf8',
  })
  assert.notEqual(result.status, 0)
  assert.match(
    result.stderr,
    /Unknown compiler rollout readiness argument: --require-legacy-removal-ready/,
  )
})

test('beta keeps legacy default without claiming human approval', async t => {
  const root = await fixture({ phase: 'beta', viteDefaultBackend: 'legacy' })
  t.after(() => rm(root, { recursive: true }))
  assert.equal(validateCompilerRolloutReadiness({ root }).phase, 'beta')
  assert.throws(
    () => validateCompilerRolloutReadiness({ root, requireDefaultReady: true }),
    /candidate evidence does not exist/,
  )
})

test('beta rejects a native package root before promotion', async t => {
  const root = await fixture({ phase: 'beta', viteDefaultBackend: 'legacy' })
  t.after(() => rm(root, { recursive: true }))
  await writeFile(
    path.join(root, 'packages', 'compiler', 'src', 'index.ts'),
    "export { nativeCompilerInfo, transformSync, transform, scanSync, scan, analyzeSync, analyze } from './native-loader'",
  )
  assert.throws(
    () => validateCompilerRolloutReadiness({ root }),
    /preserve the legacy compiler package root/,
  )
})

test('rust default requires chained candidates, native certification, and bound review', async t => {
  const evidence = candidateEvidence()
  const root = await fixture(rustDefaultState(), approvedReview(evidence), evidence)
  t.after(() => rm(root, { recursive: true }))
  assert.equal(validateCompilerRolloutReadiness({ root }).phase, 'rust-default')

  await writeFile(
    path.join(root, '.github', 'compiler-rollout-review.json'),
    JSON.stringify(
      approvedReview(evidence, {
        candidateDigest: `sha256:${'b'.repeat(64)}`,
      }),
    ),
  )
  assert.throws(() => validateCompilerRolloutReadiness({ root }), /does not bind/)
})

test('rust default rejects missing, tampered, or cross-revision native certification', async t => {
  const evidence = candidateEvidence()

  const missingRoot = await fixture(
    rustDefaultState(),
    approvedReview(evidence),
    evidence,
    undefined,
    null,
  )
  t.after(() => rm(missingRoot, { recursive: true }))
  assert.throws(
    () => validateCompilerRolloutReadiness({ root: missingRoot }),
    /native certification does not exist/,
  )

  const tampered = nativeCertification(evidence)
  tampered.releaseBundles[0].tarballSha256 = 'f'.repeat(64)
  const tamperedRoot = await fixture(
    rustDefaultState(),
    approvedReview(evidence),
    evidence,
    undefined,
    tampered,
  )
  t.after(() => rm(tamperedRoot, { recursive: true }))
  assert.throws(
    () => validateCompilerRolloutReadiness({ root: tamperedRoot }),
    /intact complete native certification/,
  )

  const invalidSizePayload = structuredClone(nativeCertification(evidence))
  delete invalidSizePayload.certificationDigest
  invalidSizePayload.releaseBundles[0].sizeGate.passed = false
  const invalidSize = {
    ...invalidSizePayload,
    certificationDigest: `sha256:${createHash('sha256')
      .update(JSON.stringify(invalidSizePayload))
      .digest('hex')}`,
  }
  const invalidSizeRoot = await fixture(
    rustDefaultState(),
    approvedReview(evidence, {
      nativeCertificationDigest: invalidSize.certificationDigest,
    }),
    evidence,
    undefined,
    invalidSize,
  )
  t.after(() => rm(invalidSizeRoot, { recursive: true }))
  assert.throws(
    () => validateCompilerRolloutReadiness({ root: invalidSizeRoot }),
    /intact complete native certification/,
  )

  const crossRevision = nativeCertification(evidence, {
    compilerBuildRevision: 'e'.repeat(40),
  })
  const crossRevisionRoot = await fixture(
    rustDefaultState(),
    approvedReview(evidence, {
      nativeCertificationDigest: crossRevision.certificationDigest,
    }),
    evidence,
    undefined,
    crossRevision,
  )
  t.after(() => rm(crossRevisionRoot, { recursive: true }))
  assert.throws(
    () => validateCompilerRolloutReadiness({ root: crossRevisionRoot }),
    /does not bind the rollout candidate source and build/,
  )
})

test('human approval binds both candidate and native certification digests', async t => {
  const evidence = candidateEvidence()
  const root = await fixture(
    rustDefaultState(),
    approvedReview(evidence, {
      nativeCertificationDigest: `sha256:${'f'.repeat(64)}`,
    }),
    evidence,
  )
  t.after(() => rm(root, { recursive: true }))
  assert.throws(
    () => validateCompilerRolloutReadiness({ root }),
    /does not bind the current native certification/,
  )
})

test('rust default rejects a legacy or incomplete native package root', async t => {
  const evidence = candidateEvidence()
  const root = await fixture(rustDefaultState(), approvedReview(evidence), evidence)
  t.after(() => rm(root, { recursive: true }))
  const compilerRootPath = path.join(root, 'packages', 'compiler', 'src', 'index.ts')

  await writeFile(
    compilerRootPath,
    "export { createFictPlugin as default } from './legacy-compiler'\nexport * from './legacy-compiler'",
  )
  assert.throws(
    () => validateCompilerRolloutReadiness({ root }),
    /must expose only the native request API/,
  )

  await writeFile(
    compilerRootPath,
    "export { nativeCompilerInfo, transformSync, transform, scan, analyze } from './native-loader'",
  )
  assert.throws(() => validateCompilerRolloutReadiness({ root }), /scanSync,analyzeSync/)
})

test('rust default rejects candidate content modified after sealing', async t => {
  const evidence = candidateEvidence()
  const root = await fixture(rustDefaultState(), approvedReview(evidence), {
    ...evidence,
    nativePackageDigest: `sha256:${'e'.repeat(64)}`,
  })
  t.after(() => rm(root, { recursive: true }))
  assert.throws(
    () => validateCompilerRolloutReadiness({ root }),
    /intact consecutive main-push schema-v5/,
  )
})

test('rust default rejects a re-signed candidate with an unbound workflow gate digest', async t => {
  const evidence = candidateEvidence({ workflowGateDigest: `sha256:${'e'.repeat(64)}` })
  const root = await fixture(rustDefaultState(), approvedReview(evidence), evidence)
  t.after(() => rm(root, { recursive: true }))
  assert.throws(
    () => validateCompilerRolloutReadiness({ root }),
    /intact consecutive main-push schema-v5/,
  )
})

test('rust default rejects non-main candidate provenance', async t => {
  const evidence = candidateEvidence({
    workflowEvent: 'pull_request',
    sourceRef: 'refs/pull/42/merge',
    promotionEligible: false,
    consecutiveGreenCandidates: 0,
    previousCandidateDigest: null,
  })
  const root = await fixture(rustDefaultState(), approvedReview(evidence), evidence)
  t.after(() => rm(root, { recursive: true }))
  assert.throws(
    () => validateCompilerRolloutReadiness({ root }),
    /intact consecutive main-push schema-v5/,
  )
})

test('human approval cannot substitute arbitrary checklist area names', async t => {
  const evidence = candidateEvidence()
  const root = await fixture(
    rustDefaultState(),
    approvedReview(evidence, {
      areas: Object.fromEntries(
        Array.from({ length: 9 }, (_, index) => [`alternate${index}`, true]),
      ),
    }),
    evidence,
  )
  t.after(() => rm(root, { recursive: true }))
  assert.throws(
    () => validateCompilerRolloutReadiness({ root }),
    /does not use the required review areas/,
  )
})

test('human approval explicitly covers the candidate native package size budget', async t => {
  const evidence = candidateEvidence()
  const root = await fixture(
    rustDefaultState(),
    approvedReview(evidence, {
      areas: { ...approvedAreas, nativePackageSizeBudget: false },
    }),
    evidence,
  )
  t.after(() => rm(root, { recursive: true }))
  assert.throws(() => validateCompilerRolloutReadiness({ root }), /nativePackageSizeBudget/)
})

test('beta cannot claim a Rust-default or compatibility release', async t => {
  const root = await fixture({
    phase: 'beta',
    viteDefaultBackend: 'legacy',
    rustDefaultRelease: '0.29.0',
  })
  t.after(() => rm(root, { recursive: true }))
  assert.throws(
    () => validateCompilerRolloutReadiness({ root }),
    /cannot claim Rust-default compatibility releases/,
  )
})

test('beta validates pending review shape before promotion', async t => {
  const root = await fixture({ phase: 'beta', viteDefaultBackend: 'legacy' })
  t.after(() => rm(root, { recursive: true }))
  const review = pendingReview()
  review.areas.coreSemantics = true
  await writeFile(
    path.join(root, '.github', 'compiler-rollout-review.json'),
    JSON.stringify(review),
  )
  assert.throws(() => validateCompilerRolloutReadiness({ root }), /cannot contain partial approval/)

  const digestReview = pendingReview()
  digestReview.nativeCertificationDigest = `sha256:${'f'.repeat(64)}`
  await writeFile(
    path.join(root, '.github', 'compiler-rollout-review.json'),
    JSON.stringify(digestReview),
  )
  assert.throws(() => validateCompilerRolloutReadiness({ root }), /cannot contain partial approval/)

  await writeFile(
    path.join(root, '.github', 'compiler-rollout-review.json'),
    JSON.stringify(pendingReview()),
  )
  await writeFile(
    path.join(root, '.github', 'compiler-legacy-removal-evidence.json'),
    JSON.stringify({
      schemaVersion: 1,
      status: 'pending',
      rustDefaultRelease: '0.29.0',
      evidenceDigest: null,
    }),
  )
  assert.throws(() => validateCompilerRolloutReadiness({ root }), /cannot contain partial claims/)
})

test('rollout state evidence paths cannot escape the workspace', async t => {
  const root = await fixture({
    phase: 'beta',
    viteDefaultBackend: 'legacy',
    reviewPath: '../compiler-rollout-review.json',
  })
  t.after(() => rm(root, { recursive: true }))
  assert.throws(() => validateCompilerRolloutReadiness({ root }), /must remain inside/)

  const nativeRoot = await fixture({
    phase: 'beta',
    viteDefaultBackend: 'legacy',
    nativeCertificationPath: '/tmp/compiler-native-certification.json',
  })
  t.after(() => rm(nativeRoot, { recursive: true }))
  assert.throws(
    () => validateCompilerRolloutReadiness({ root: nativeRoot }),
    /nativeCertificationPath must remain inside/,
  )

  const removalEvidenceRoot = await fixture({
    phase: 'beta',
    viteDefaultBackend: 'legacy',
    legacyRemovalEvidencePath: '../compiler-legacy-removal-evidence.json',
  })
  t.after(() => rm(removalEvidenceRoot, { recursive: true }))
  assert.throws(
    () => validateCompilerRolloutReadiness({ root: removalEvidenceRoot }),
    /legacyRemovalEvidencePath must remain inside/,
  )
})

test('legacy removal requires a bound review and a completed stable minor window', async t => {
  const evidence = candidateEvidence()
  const candidateReview = approvedReview(evidence)
  const state = {
    phase: 'legacy-removal',
    viteDefaultBackend: 'rust',
    rollbackBackend: 'rust',
    rustDefaultRelease: '0.29.0',
    compatibilityRelease: '0.30.0',
    finalLegacyRelease: '0.30.1',
    legacyRemovalRelease: '1.0.0',
  }
  const removalEvidence = legacyRemovalEvidence(state)
  const removalReview = approvedRemovalReview(state, removalEvidence)
  const root = await fixture(
    state,
    candidateReview,
    evidence,
    removalReview,
    undefined,
    removalEvidence,
  )
  t.after(() => rm(root, { recursive: true }))
  assert.equal(validateCompilerRolloutReadiness({ root }).phase, 'legacy-removal')

  const removalEvidencePath = path.join(root, '.github', 'compiler-legacy-removal-evidence.json')
  await writeFile(
    removalEvidencePath,
    JSON.stringify({
      ...removalEvidence,
      consumerValidation: {
        ...removalEvidence.consumerValidation,
        commitSha: 'f'.repeat(40),
      },
    }),
  )
  assert.throws(() => validateCompilerRolloutReadiness({ root }), /one intact digest-bound record/)
  await writeFile(removalEvidencePath, JSON.stringify(removalEvidence))

  const missingReleaseAssetEvidence = legacyRemovalEvidence(state, {
    publishedReleases: {
      ...removalEvidence.publishedReleases,
      finalLegacy: {
        ...removalEvidence.publishedReleases.finalLegacy,
        githubRelease: {
          ...removalEvidence.publishedReleases.finalLegacy.githubRelease,
          assets: removalEvidence.publishedReleases.finalLegacy.githubRelease.assets.slice(1),
        },
      },
    },
  })
  await writeFile(removalEvidencePath, JSON.stringify(missingReleaseAssetEvidence))
  assert.throws(
    () => validateCompilerRolloutReadiness({ root }),
    /invalid final legacy release publication proof/,
  )

  const crossRunCertificationEvidence = legacyRemovalEvidence(state, {
    nativeCertification: {
      ...removalEvidence.nativeCertification,
      workflowRunId: '999',
    },
  })
  await writeFile(removalEvidencePath, JSON.stringify(crossRunCertificationEvidence))
  assert.throws(
    () => validateCompilerRolloutReadiness({ root }),
    /invalid native certification proof/,
  )
  await writeFile(removalEvidencePath, JSON.stringify(removalEvidence))

  const migrationGuidancePath = path.join(root, 'docs', 'compiler-rust-only-migration.md')
  await writeFile(migrationGuidancePath, '# Unreviewed migration rewrite\n')
  assert.throws(
    () => validateCompilerRolloutReadiness({ root }),
    /migration guidance digest does not match/,
  )
  await writeFile(migrationGuidancePath, migrationGuidanceContent)

  await writeFile(
    path.join(root, '.github', 'compiler-legacy-removal-review.json'),
    JSON.stringify({ ...removalReview, evidenceDigest: `sha256:${'f'.repeat(64)}` }),
  )
  assert.throws(
    () => validateCompilerRolloutReadiness({ root }),
    /does not bind the current release evidence/,
  )
  await writeFile(
    path.join(root, '.github', 'compiler-legacy-removal-review.json'),
    JSON.stringify(removalReview),
  )

  const viteSourcePath = path.join(root, 'packages', 'vite-plugin', 'src', 'index.ts')
  await writeFile(
    viteSourcePath,
    "const backend = backendOption ?? backendFromEnvironment ?? 'rust'\nloadNativeCompilerBinding()",
  )
  assert.throws(
    () => validateCompilerRolloutReadiness({ root }),
    /native-only without backend option/,
  )

  await writeFile(viteSourcePath, 'const backend = process.env.FICT_COMPILER_BACKEND')
  assert.throws(() => validateCompilerRolloutReadiness({ root }), /without FICT_COMPILER_BACKEND/)

  await writeFile(
    viteSourcePath,
    "const selected = options.backend ?? 'rust'\nloadNativeCompilerBinding()",
  )
  assert.throws(
    () => validateCompilerRolloutReadiness({ root }),
    /without compiler backend selection/,
  )

  await writeFile(viteSourcePath, "const backend = 'rust'")
  assert.throws(
    () => validateCompilerRolloutReadiness({ root }),
    /must load the native compiler directly/,
  )
  await writeFile(viteSourcePath, 'const nativeCompiler = loadNativeCompilerBinding()')

  await writeFile(
    path.join(root, '.github', 'compiler-legacy-removal-review.json'),
    JSON.stringify({
      ...removalReview,
      areas: { ...approvedRemovalAreas, subsequentMinorCompleted: false },
    }),
  )
  assert.throws(() => validateCompilerRolloutReadiness({ root }), /subsequentMinorCompleted/)

  await writeFile(
    path.join(root, '.github', 'compiler-legacy-removal-review.json'),
    JSON.stringify(removalReview),
  )
  await mkdir(path.join(root, 'packages', 'babel-preset'), { recursive: true })
  await writeFile(
    path.join(root, 'packages', 'babel-preset', 'package.json'),
    JSON.stringify({ name: '@fictjs/babel-preset' }),
  )
  assert.throws(
    () => validateCompilerRolloutReadiness({ root }),
    /Legacy compiler removal is incomplete/,
  )

  await rm(path.join(root, 'packages', 'babel-preset'), { recursive: true })
  await writeFile(
    path.join(root, 'packages', 'vite-plugin', 'package.json'),
    JSON.stringify({
      name: '@fictjs/vite-plugin',
      dependencies: { '@babel/parser': '7.0.0' },
    }),
  )
  assert.throws(() => validateCompilerRolloutReadiness({ root }), /dependencies\.@babel\/parser/)

  await rm(path.join(root, 'packages', 'vite-plugin', 'package.json'))
  await writeFile(path.join(root, 'SCOPE.md'), '@fictjs/babel-preset is still Core')
  assert.throws(() => validateCompilerRolloutReadiness({ root }), /SCOPE\.md/)

  await rm(path.join(root, 'SCOPE.md'))
  await writeFile(path.join(root, 'packages', 'compiler', 'src', 'legacy-compiler.ts'), 'export {}')
  assert.throws(() => validateCompilerRolloutReadiness({ root }), /legacy-compiler\.ts/)

  await rm(path.join(root, 'packages', 'compiler', 'src', 'legacy-compiler.ts'))
  await writeFile(path.join(root, 'packages', 'compiler', 'src', 'legacy.ts'), 'export {}')
  assert.throws(() => validateCompilerRolloutReadiness({ root }), /src\/legacy\.ts/)

  await rm(path.join(root, 'packages', 'compiler', 'src', 'legacy.ts'))
  await writeFile(
    path.join(root, 'packages', 'compiler', 'package.json'),
    JSON.stringify({
      name: '@fictjs/compiler',
      exports: { '.': './dist/index.js', './legacy': './dist/legacy.js' },
    }),
  )
  assert.throws(() => validateCompilerRolloutReadiness({ root }), /exports\[\.\/legacy\]/)

  await writeFile(
    path.join(root, 'packages', 'compiler', 'package.json'),
    JSON.stringify({ name: '@fictjs/compiler', exports: { '.': './dist/index.js' } }),
  )
  await writeFile(
    path.join(root, 'packages', 'compiler', 'src', 'index.ts'),
    "import type { NodePath } from '@babel/core'; export { nativeCompilerInfo, transformSync, transform, scanSync, scan, analyzeSync, analyze } from './native-loader'",
  )
  assert.throws(() => validateCompilerRolloutReadiness({ root }), /compiler\/src\/index\.ts/)

  await writeFile(
    path.join(root, 'packages', 'compiler', 'src', 'index.ts'),
    "export { nativeCompilerInfo, transformSync, transform, scanSync, scan, analyzeSync, analyze } from './native-loader'",
  )
  await writeFile(
    path.join(root, 'packages', 'compiler', 'src', 'index.ts'),
    "export { transformSync } from './native-loader'",
  )
  assert.throws(() => validateCompilerRolloutReadiness({ root }), /missing-native-api/)

  await writeFile(
    path.join(root, 'packages', 'compiler', 'src', 'index.ts'),
    "export { nativeCompilerInfo, transformSync, transform, scanSync, scan, analyzeSync, analyze } from './native-loader'",
  )
  await mkdir(path.join(root, 'packages', 'webpack-plugin', 'src'), { recursive: true })
  await writeFile(
    path.join(root, 'packages', 'webpack-plugin', 'src', 'shared.ts'),
    'const isLegacyV1 = true',
  )
  assert.throws(() => validateCompilerRolloutReadiness({ root }), /isLegacyV/)
})

test('legacy removal rejects a same-major release after 1.0', async t => {
  const root = await fixture({
    phase: 'legacy-removal',
    viteDefaultBackend: 'rust',
    rollbackBackend: 'rust',
    rustDefaultRelease: '1.2.0',
    compatibilityRelease: '1.3.0',
    finalLegacyRelease: '1.3.1',
    legacyRemovalRelease: '1.4.0',
  })
  t.after(() => rm(root, { recursive: true }))
  assert.throws(
    () => validateCompilerRolloutReadiness({ root }),
    /later stable semver major release/,
  )
})

test('legacy removal rejects a patch release as the compatibility window', async t => {
  const root = await fixture({
    phase: 'legacy-removal',
    viteDefaultBackend: 'rust',
    rollbackBackend: 'rust',
    rustDefaultRelease: '0.29.0',
    compatibilityRelease: '0.29.1',
    finalLegacyRelease: '0.30.0',
    legacyRemovalRelease: '1.0.0',
  })
  t.after(() => rm(root, { recursive: true }))
  assert.throws(
    () => validateCompilerRolloutReadiness({ root }),
    /complete subsequent stable minor/,
  )
})
