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

function candidateEvidence(overrides = {}) {
  const artifactDigest = `sha256:${'b'.repeat(64)}`
  const payload = {
    schemaVersion: 2,
    status: 'pass',
    runId: '101',
    runAttempt: '1',
    sourceRevision: 'c'.repeat(40),
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

async function fixture(state, review, evidence) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fict-rollout-'))
  await mkdir(path.join(root, '.github'), { recursive: true })
  await mkdir(path.join(root, 'packages', 'vite-plugin', 'src'), { recursive: true })
  await writeFile(
    path.join(root, '.github', 'compiler-rollout-state.json'),
    JSON.stringify({
      schemaVersion: 1,
      rollbackBackend: 'legacy',
      candidateEvidencePath: '.github/compiler-rollout-evidence.json',
      reviewPath: '.github/compiler-rollout-review.json',
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
    { phase: 'rust-default', viteDefaultBackend: 'rust' },
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
    { phase: 'rust-default', viteDefaultBackend: 'rust' },
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
  assert.throws(() => validateCompilerRolloutReadiness({ root }), /intact consecutive schema-v2/)
})

test('human approval cannot substitute arbitrary checklist area names', async t => {
  const evidence = candidateEvidence()
  const { candidateDigest } = evidence
  const root = await fixture(
    { phase: 'rust-default', viteDefaultBackend: 'rust' },
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
    { phase: 'rust-default', viteDefaultBackend: 'rust' },
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
