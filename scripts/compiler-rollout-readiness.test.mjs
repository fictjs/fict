import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { validateCompilerRolloutReadiness } from './compiler-rollout-readiness.mjs'

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
  const candidateDigest = `sha256:${'a'.repeat(64)}`
  const evidence = {
    schemaVersion: 1,
    status: 'pass',
    consecutiveGreenCandidates: 2,
    candidateDigest,
  }
  const areas = {
    coreSemantics: true,
    strictGuarantee: true,
    typescriptNamespacesAndCts: true,
    runtimeAndMetadataAbi: true,
    sourceMaps: true,
    nativePlatformsAndRelease: true,
    performanceAndRss: true,
    rollbackDrill: true,
  }
  const root = await fixture(
    { phase: 'rust-default', viteDefaultBackend: 'rust' },
    { schemaVersion: 1, status: 'approved', candidateDigest, reviewer: 'maintainer', areas },
    evidence,
  )
  t.after(() => rm(root, { recursive: true }))
  assert.equal(validateCompilerRolloutReadiness({ root }).phase, 'rust-default')

  await writeFile(
    path.join(root, '.github', 'compiler-rollout-review.json'),
    JSON.stringify({
      schemaVersion: 1,
      status: 'approved',
      candidateDigest: `sha256:${'b'.repeat(64)}`,
      reviewer: 'maintainer',
      areas,
    }),
  )
  assert.throws(() => validateCompilerRolloutReadiness({ root }), /does not bind/)
})

test('human approval cannot substitute arbitrary checklist area names', async t => {
  const candidateDigest = `sha256:${'a'.repeat(64)}`
  const root = await fixture(
    { phase: 'rust-default', viteDefaultBackend: 'rust' },
    {
      schemaVersion: 1,
      status: 'approved',
      candidateDigest,
      reviewer: 'maintainer',
      areas: Object.fromEntries(
        Array.from({ length: 8 }, (_, index) => [`alternate${index}`, true]),
      ),
    },
    {
      schemaVersion: 1,
      status: 'pass',
      consecutiveGreenCandidates: 2,
      candidateDigest,
    },
  )
  t.after(() => rm(root, { recursive: true }))
  assert.throws(
    () => validateCompilerRolloutReadiness({ root }),
    /does not use the required rollout areas/,
  )
})
