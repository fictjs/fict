import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const script = path.join(root, 'scripts', 'compiler-rollout-candidate.mjs')
const revision = 'a'.repeat(40)

async function evidence(directory, compilerBuildId = 'fict-rust-test') {
  const documents = {
    shadow: {
      schemaVersion: 1,
      backend: 'shadow',
      compilerBuildId,
      summary: { modules: 1, unexplainedDifferences: 0 },
    },
    benchmark: {
      schemaVersion: 1,
      compilerBuildId,
      status: 'pass',
      violations: [],
    },
    runtime: {
      schemaVersion: 1,
      compilerBuildId,
      status: 'pass',
      contracts: {
        coreRuntimeParity: true,
        strictGuaranteeMatrix: true,
        nativeRuntimeRegressionSuite: true,
      },
    },
    rollback: {
      schemaVersion: 1,
      compilerBuildId,
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
      schemaVersion: 1,
      target: 'linux-x64-gnu',
      compilerBuildId,
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

function run(directory, runId, output, extra = []) {
  return spawnSync(
    process.execPath,
    [
      script,
      `--shadow=${path.join(directory, 'shadow.json')}`,
      `--benchmark=${path.join(directory, 'benchmark.json')}`,
      `--runtime=${path.join(directory, 'runtime.json')}`,
      `--rollback=${path.join(directory, 'rollback.json')}`,
      `--package=${path.join(directory, 'package.json')}`,
      `--revision=${revision}`,
      `--run-id=${runId}`,
      `--output=${output}`,
      ...extra,
    ],
    { cwd: root, encoding: 'utf8' },
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
  assert.equal(firstArtifact.schemaVersion, 2)
  assert.match(firstArtifact.nativePackageDigest, /^sha256:[0-9a-f]{64}$/)
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
      schemaVersion: 2,
      status: 'pass',
      runId: '99',
      runAttempt: '1',
      candidateDigest: `sha256:${'a'.repeat(64)}`,
      consecutiveGreenCandidates: '2',
    }),
  )
  const malformed = run(directory, '100', path.join(directory, 'candidate.json'), [
    `--previous=${previousPath}`,
  ])
  assert.notEqual(malformed.status, 0)
  assert.match(malformed.stderr, /not a passing schema-v2 candidate/)
})
