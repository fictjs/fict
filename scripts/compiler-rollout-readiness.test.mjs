import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { validateCompilerRolloutReadiness } from './compiler-rollout-readiness.mjs'

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

function rustDefaultState(overrides = {}) {
  return {
    phase: 'rust-default',
    viteDefaultBackend: 'rust',
    rustDefaultRelease: '0.29.0',
    ...overrides,
  }
}

function candidateEvidence(overrides = {}) {
  const artifactDigest = `sha256:${'b'.repeat(64)}`
  const payload = {
    schemaVersion: 3,
    status: 'pass',
    runId: '101',
    runAttempt: '1',
    sourceRevision: 'c'.repeat(40),
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
    ...overrides,
  }
  return {
    ...payload,
    candidateDigest: `sha256:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`,
  }
}

async function fixture(state, review, evidence, removalReview) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fict-rollout-'))
  await mkdir(path.join(root, '.github'), { recursive: true })
  await mkdir(path.join(root, 'packages', 'vite-plugin', 'src'), { recursive: true })
  await writeFile(
    path.join(root, '.github', 'compiler-rollout-state.json'),
    JSON.stringify({
      schemaVersion: 2,
      rollbackBackend: 'legacy',
      rustDefaultRelease: null,
      compatibilityRelease: null,
      finalLegacyRelease: null,
      legacyRemovalRelease: null,
      candidateEvidencePath: '.github/compiler-rollout-evidence.json',
      reviewPath: '.github/compiler-rollout-review.json',
      legacyRemovalReviewPath: '.github/compiler-legacy-removal-review.json',
      ...state,
    }),
  )
  await writeFile(
    path.join(root, 'packages', 'vite-plugin', 'src', 'index.ts'),
    `const backend = backendOption ?? backendFromEnvironment ?? '${state.viteDefaultBackend}'`,
  )
  if (review) {
    await writeFile(
      path.join(root, '.github', 'compiler-rollout-review.json'),
      JSON.stringify(review),
    )
  }
  if (evidence) {
    await writeFile(
      path.join(root, '.github', 'compiler-rollout-evidence.json'),
      JSON.stringify(evidence),
    )
  }
  if (removalReview) {
    await writeFile(
      path.join(root, '.github', 'compiler-legacy-removal-review.json'),
      JSON.stringify(removalReview),
    )
  }
  return root
}

test('beta keeps legacy default without claiming human approval', async t => {
  const root = await fixture({ phase: 'beta', viteDefaultBackend: 'legacy' })
  t.after(() => rm(root, { recursive: true }))
  assert.equal(validateCompilerRolloutReadiness({ root }).phase, 'beta')
  assert.throws(
    () => validateCompilerRolloutReadiness({ root, requireDefaultReady: true }),
    /candidate evidence does not exist/,
  )
})

test('rust default requires chained candidates and a checklist bound to their digest', async t => {
  const evidence = candidateEvidence()
  const { candidateDigest } = evidence
  const areas = approvedAreas
  const root = await fixture(
    rustDefaultState(),
    { schemaVersion: 2, status: 'approved', candidateDigest, reviewer: 'maintainer', areas },
    evidence,
  )
  t.after(() => rm(root, { recursive: true }))
  assert.equal(validateCompilerRolloutReadiness({ root }).phase, 'rust-default')

  await writeFile(
    path.join(root, '.github', 'compiler-rollout-review.json'),
    JSON.stringify({
      schemaVersion: 2,
      status: 'approved',
      candidateDigest: `sha256:${'b'.repeat(64)}`,
      reviewer: 'maintainer',
      areas,
    }),
  )
  assert.throws(() => validateCompilerRolloutReadiness({ root }), /does not bind/)
})

test('rust default rejects candidate content modified after sealing', async t => {
  const evidence = candidateEvidence()
  const root = await fixture(
    rustDefaultState(),
    {
      schemaVersion: 2,
      status: 'approved',
      candidateDigest: evidence.candidateDigest,
      reviewer: 'maintainer',
      areas: approvedAreas,
    },
    { ...evidence, nativePackageDigest: `sha256:${'e'.repeat(64)}` },
  )
  t.after(() => rm(root, { recursive: true }))
  assert.throws(
    () => validateCompilerRolloutReadiness({ root }),
    /intact consecutive main-push schema-v3/,
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
  const root = await fixture(
    rustDefaultState(),
    {
      schemaVersion: 2,
      status: 'approved',
      candidateDigest: evidence.candidateDigest,
      reviewer: 'maintainer',
      areas: approvedAreas,
    },
    evidence,
  )
  t.after(() => rm(root, { recursive: true }))
  assert.throws(
    () => validateCompilerRolloutReadiness({ root }),
    /intact consecutive main-push schema-v3/,
  )
})

test('human approval cannot substitute arbitrary checklist area names', async t => {
  const evidence = candidateEvidence()
  const { candidateDigest } = evidence
  const root = await fixture(
    rustDefaultState(),
    {
      schemaVersion: 2,
      status: 'approved',
      candidateDigest,
      reviewer: 'maintainer',
      areas: Object.fromEntries(
        Array.from({ length: 9 }, (_, index) => [`alternate${index}`, true]),
      ),
    },
    evidence,
  )
  t.after(() => rm(root, { recursive: true }))
  assert.throws(
    () => validateCompilerRolloutReadiness({ root }),
    /does not use the required rollout areas/,
  )
})

test('human approval explicitly covers the candidate native package size budget', async t => {
  const evidence = candidateEvidence()
  const root = await fixture(
    rustDefaultState(),
    {
      schemaVersion: 2,
      status: 'approved',
      candidateDigest: evidence.candidateDigest,
      reviewer: 'maintainer',
      areas: { ...approvedAreas, nativePackageSizeBudget: false },
    },
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

test('legacy removal requires a bound review and a completed stable minor window', async t => {
  const evidence = candidateEvidence()
  const candidateReview = {
    schemaVersion: 2,
    status: 'approved',
    candidateDigest: evidence.candidateDigest,
    reviewer: 'maintainer',
    areas: approvedAreas,
  }
  const state = {
    phase: 'legacy-removal',
    viteDefaultBackend: 'rust',
    rollbackBackend: 'rust',
    rustDefaultRelease: '0.29.0',
    compatibilityRelease: '0.30.0',
    finalLegacyRelease: '0.30.1',
    legacyRemovalRelease: '1.0.0',
  }
  const removalReview = {
    schemaVersion: 1,
    status: 'approved',
    reviewer: 'release-maintainer',
    rustDefaultRelease: state.rustDefaultRelease,
    compatibilityRelease: state.compatibilityRelease,
    finalLegacyRelease: state.finalLegacyRelease,
    legacyRemovalRelease: state.legacyRemovalRelease,
    areas: approvedRemovalAreas,
  }
  const root = await fixture(state, candidateReview, evidence, removalReview)
  t.after(() => rm(root, { recursive: true }))
  assert.equal(validateCompilerRolloutReadiness({ root }).phase, 'legacy-removal')

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
