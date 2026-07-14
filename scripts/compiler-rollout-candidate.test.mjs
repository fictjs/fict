import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { REQUIRED_ROLLOUT_JOBS } from './compiler-rollout-workflow-contract.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const script = path.join(root, 'scripts', 'compiler-rollout-candidate.mjs')
const revision = 'a'.repeat(40)

function digest(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

async function evidence(directory, compilerBuildId = 'fict-rust-test') {
  const documents = {
    shadow: {
      schemaVersion: 2,
      backend: 'shadow',
      compilerBuildId,
      compilerBuildRevision: revision,
      summary: { modules: 1, unexplainedDifferences: 0 },
    },
    benchmark: {
      schemaVersion: 2,
      compilerBuildId,
      compilerBuildRevision: revision,
      status: 'pass',
      violations: [],
    },
    runtime: {
      schemaVersion: 2,
      compilerBuildId,
      compilerBuildRevision: revision,
      status: 'pass',
      contracts: {
        coreRuntimeParity: true,
        strictGuaranteeMatrix: true,
        nativeRuntimeRegressionSuite: true,
      },
    },
    rollback: {
      schemaVersion: 2,
      compilerBuildId,
      compilerBuildRevision: revision,
      status: 'pass',
      rollbackUnit: 'whole-build',
      purged: {
        compilerCache: true,
        metadataCache: true,
        bundlerCache: true,
        generatedOutput: true,
      },
    },
    package: {
      schemaVersion: 2,
      target: 'linux-x64-gnu',
      compilerBuildId,
      compilerBuildRevision: revision,
      binarySha256: 'b'.repeat(64),
      tarballSha256: 'c'.repeat(64),
      tarballBytes: 3_000_000,
      unpackedBytes: 7_000_000,
      formats: ['esm', 'cjs'],
      syncAndAsync: true,
      rustToolchainRequired: false,
      sizeGate: {
        schemaVersion: 1,
        target: 'linux-x64-gnu',
        profile: 'ci',
        tarballBytes: 3_000_000,
        unpackedBytes: 7_000_000,
        maximumTarballBytes: 8_388_608,
        maximumUnpackedBytes: 20_971_520,
        passed: true,
        violations: [],
      },
    },
  }
  for (const [name, document] of Object.entries(documents)) {
    await writeFile(path.join(directory, `${name}.json`), JSON.stringify(document))
  }
}

function argumentValue(extra, name, fallback) {
  return (
    extra.find(argument => argument.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
  )
}

function run(directory, runId, output, extra = [], gateOverrides = {}) {
  const workflowEvent = argumentValue(extra, 'event', 'push')
  const sourceRef = argumentValue(extra, 'ref', 'refs/heads/main')
  const runAttempt = argumentValue(extra, 'run-attempt', '1')
  const gatePath = path.join(directory, `workflow-gate-${runId}-${runAttempt}.json`)
  const jobs = Object.fromEntries(
    REQUIRED_ROLLOUT_JOBS.map(job => [job, job === 'rust-fuzz' ? 'skipped' : 'success']),
  )
  const workflowGate = {
    schemaVersion: 1,
    status: 'pass',
    repository: 'fictjs/fict',
    workflowName: 'CI',
    workflowJob: 'compiler-rollout-finalize',
    runId,
    runAttempt,
    sourceRevision: revision,
    workflowEvent,
    sourceRef,
    ...gateOverrides,
    jobs: { ...jobs, ...gateOverrides.jobs },
  }
  writeFileSync(gatePath, JSON.stringify(workflowGate))
  return spawnSync(
    process.execPath,
    [
      script,
      `--shadow=${path.join(directory, 'shadow.json')}`,
      `--benchmark=${path.join(directory, 'benchmark.json')}`,
      `--runtime=${path.join(directory, 'runtime.json')}`,
      `--rollback=${path.join(directory, 'rollback.json')}`,
      `--package=${path.join(directory, 'package.json')}`,
      `--workflow-gate=${gatePath}`,
      `--revision=${revision}`,
      `--run-id=${runId}`,
      `--output=${output}`,
      ...extra,
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REF: 'refs/heads/main',
      },
    },
  )
}

test('candidate evidence chains two distinct green builds', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fict-candidate-'))
  t.after(() => rm(directory, { recursive: true }))
  await evidence(directory)
  const firstPath = path.join(directory, 'candidate-1.json')
  const secondPath = path.join(directory, 'candidate-2.json')

  const first = run(directory, '100', firstPath)
  assert.equal(first.status, 0, first.stderr)
  const second = run(directory, '101', secondPath, [`--previous=${firstPath}`, '--require-two'])
  assert.equal(second.status, 0, second.stderr)

  const firstArtifact = JSON.parse(await readFile(firstPath, 'utf8'))
  const secondArtifact = JSON.parse(await readFile(secondPath, 'utf8'))
  assert.equal(firstArtifact.consecutiveGreenCandidates, 1)
  assert.equal(secondArtifact.consecutiveGreenCandidates, 2)
  assert.equal(secondArtifact.previousCandidateDigest, firstArtifact.candidateDigest)
  assert.equal(firstArtifact.schemaVersion, 5)
  assert.equal(firstArtifact.compilerBuildRevision, revision)
  assert.equal(firstArtifact.promotionEligible, true)
  assert.equal(firstArtifact.workflowEvent, 'push')
  assert.equal(firstArtifact.sourceRef, 'refs/heads/main')
  assert.match(firstArtifact.nativePackageDigest, /^sha256:[0-9a-f]{64}$/)
  assert.match(firstArtifact.workflowGateDigest, /^sha256:[0-9a-f]{64}$/)
  assert.equal(firstArtifact.workflowGate.jobs.e2e, 'success')
})

test('candidate CLI rejects an unknown flag instead of bypassing require-two', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fict-candidate-cli-'))
  t.after(() => rm(directory, { recursive: true }))
  const result = run(directory, '100', path.join(directory, 'candidate.json'), ['--require-tow'])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Unknown compiler rollout candidate argument: --require-tow/)
})

test('non-main candidates cannot count toward or extend the promotion chain', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fict-candidate-non-main-'))
  t.after(() => rm(directory, { recursive: true }))
  await evidence(directory)
  const pullRequestPath = path.join(directory, 'candidate-pr.json')

  const pullRequest = run(directory, '100', pullRequestPath, [
    '--event=pull_request',
    '--ref=refs/pull/42/merge',
  ])
  assert.equal(pullRequest.status, 0, pullRequest.stderr)
  const artifact = JSON.parse(await readFile(pullRequestPath, 'utf8'))
  assert.equal(artifact.promotionEligible, false)
  assert.equal(artifact.consecutiveGreenCandidates, 0)
  assert.equal(artifact.previousCandidateDigest, null)

  const chained = run(directory, '101', path.join(directory, 'candidate-main.json'), [
    `--previous=${pullRequestPath}`,
  ])
  assert.notEqual(chained.status, 0)
  assert.match(chained.stderr, /promotion-eligible schema-v5 candidate/)
})

test('candidate evidence rejects mixed native compiler builds', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fict-candidate-mixed-'))
  t.after(() => rm(directory, { recursive: true }))
  await evidence(directory)
  const runtime = JSON.parse(await readFile(path.join(directory, 'runtime.json'), 'utf8'))
  runtime.compilerBuildId = 'different-build'
  await writeFile(path.join(directory, 'runtime.json'), JSON.stringify(runtime))

  const result = run(directory, '100', path.join(directory, 'candidate.json'))
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /one native compiler build/)
})

test('candidate evidence rejects native artifacts built from another revision', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fict-candidate-revision-'))
  t.after(() => rm(directory, { recursive: true }))
  await evidence(directory)
  const runtime = JSON.parse(await readFile(path.join(directory, 'runtime.json'), 'utf8'))
  runtime.compilerBuildRevision = 'b'.repeat(40)
  await writeFile(path.join(directory, 'runtime.json'), JSON.stringify(runtime))

  const result = run(directory, '100', path.join(directory, 'candidate.json'))
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /candidate source revision/)
})

test('candidate evidence rejects native packages that failed their size gate', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fict-candidate-package-'))
  t.after(() => rm(directory, { recursive: true }))
  await evidence(directory)
  const packageEvidence = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'))
  packageEvidence.sizeGate.passed = false
  packageEvidence.sizeGate.violations = ['tarball exceeds budget']
  await writeFile(path.join(directory, 'package.json'), JSON.stringify(packageEvidence))

  const result = run(directory, '100', path.join(directory, 'candidate.json'))
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Native package evidence is incomplete or exceeds its size budget/)
})

test('candidate evidence rejects an incomplete final workflow gate', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fict-candidate-workflow-'))
  t.after(() => rm(directory, { recursive: true }))
  await evidence(directory)
  const result = run(directory, '100', path.join(directory, 'candidate.json'), [], {
    jobs: { e2e: 'failure' },
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /CI job e2e did not pass/)
})

test('candidate evidence rejects non-CI run identities and malformed previous chains', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fict-candidate-identity-'))
  t.after(() => rm(directory, { recursive: true }))
  await evidence(directory)

  const local = run(directory, 'local', path.join(directory, 'candidate-local.json'))
  assert.notEqual(local.status, 0)
  assert.match(local.stderr, /numeric --run-id/)

  const previousPath = path.join(directory, 'previous.json')
  await writeFile(
    previousPath,
    JSON.stringify({
      schemaVersion: 5,
      status: 'pass',
      runId: '99',
      runAttempt: '1',
      workflowEvent: 'push',
      sourceRef: 'refs/heads/main',
      promotionEligible: true,
      candidateDigest: `sha256:${'a'.repeat(64)}`,
      consecutiveGreenCandidates: '2',
    }),
  )
  const malformed = run(directory, '100', path.join(directory, 'candidate.json'), [
    `--previous=${previousPath}`,
  ])
  assert.notEqual(malformed.status, 0)
  assert.match(malformed.stderr, /not a promotion-eligible schema-v5 candidate/)
})

test('candidate evidence rejects a re-signed continuation without a previous digest', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fict-candidate-topology-'))
  t.after(() => rm(directory, { recursive: true }))
  await evidence(directory)
  const previousPath = path.join(directory, 'previous.json')
  const first = run(directory, '100', previousPath)
  assert.equal(first.status, 0, first.stderr)

  const firstArtifact = JSON.parse(await readFile(previousPath, 'utf8'))
  const payload = { ...firstArtifact }
  delete payload.candidateDigest
  payload.consecutiveGreenCandidates = 2
  payload.previousCandidateDigest = null
  await writeFile(previousPath, JSON.stringify({ ...payload, candidateDigest: digest(payload) }))

  const result = run(directory, '101', path.join(directory, 'candidate.json'), [
    `--previous=${previousPath}`,
  ])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /promotion-eligible schema-v5 candidate/)
})
