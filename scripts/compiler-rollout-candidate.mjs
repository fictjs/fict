#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { assertCliArguments } from './strict-cli-arguments.mjs'
import { validateWorkflowGateArtifact } from './compiler-rollout-workflow-contract.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
assertCliArguments(process.argv.slice(2), {
  command: 'compiler rollout candidate',
  valueArguments: [
    'workflow-gate',
    'shadow',
    'benchmark',
    'runtime',
    'rollback',
    'package',
    'output',
    'previous',
    'run-id',
    'run-attempt',
    'revision',
    'event',
    'ref',
  ],
  flagArguments: ['require-two'],
})

function readArgument(name, fallback) {
  const prefix = `--${name}=`
  const inline = process.argv.find(argument => argument.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

function readJson(filename, label) {
  if (!filename || !existsSync(filename)) throw new Error(`${label} does not exist: ${filename}`)
  return JSON.parse(readFileSync(filename, 'utf8'))
}

function digest(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

function gitRevision() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) throw new Error('Unable to resolve candidate git revision')
  return result.stdout.trim()
}

function validateShadow(artifact) {
  if (
    artifact.schemaVersion !== 2 ||
    artifact.backend !== 'shadow' ||
    !/^[0-9a-f]{40}$/.test(artifact.compilerBuildRevision ?? '') ||
    artifact.summary?.modules < 1 ||
    artifact.summary?.unexplainedDifferences !== 0
  ) {
    throw new Error('Shadow artifact is missing modules or contains unexplained differences')
  }
}

function validateBenchmark(artifact) {
  if (
    artifact.schemaVersion !== 2 ||
    !/^[0-9a-f]{40}$/.test(artifact.compilerBuildRevision ?? '') ||
    artifact.status !== 'pass' ||
    artifact.violations?.length
  ) {
    throw new Error('Compiler backend benchmark did not pass its performance/RSS budgets')
  }
}

function validateRuntime(artifact) {
  if (
    artifact.schemaVersion !== 2 ||
    !/^[0-9a-f]{40}$/.test(artifact.compilerBuildRevision ?? '') ||
    artifact.status !== 'pass' ||
    !artifact.contracts?.coreRuntimeParity ||
    !artifact.contracts?.strictGuaranteeMatrix ||
    !artifact.contracts?.nativeRuntimeRegressionSuite
  ) {
    throw new Error('Runtime parity evidence is incomplete')
  }
}

function validateRollback(artifact) {
  if (
    artifact.schemaVersion !== 2 ||
    !/^[0-9a-f]{40}$/.test(artifact.compilerBuildRevision ?? '') ||
    artifact.status !== 'pass' ||
    artifact.rollbackUnit !== 'whole-build' ||
    Object.values(artifact.purged ?? {}).length !== 4 ||
    Object.values(artifact.purged ?? {}).some(value => value !== true)
  ) {
    throw new Error('Whole-build rollback drill evidence is incomplete')
  }
}

function validateNativePackage(artifact) {
  const sizeGate = artifact.sizeGate
  if (
    artifact.schemaVersion !== 2 ||
    typeof artifact.target !== 'string' ||
    !artifact.target ||
    typeof artifact.compilerBuildId !== 'string' ||
    !artifact.compilerBuildId ||
    !/^[0-9a-f]{40}$/.test(artifact.compilerBuildRevision ?? '') ||
    !/^sha256:[0-9a-f]{64}$/.test(`sha256:${artifact.binarySha256 ?? ''}`) ||
    !/^sha256:[0-9a-f]{64}$/.test(`sha256:${artifact.tarballSha256 ?? ''}`) ||
    !Number.isSafeInteger(artifact.tarballBytes) ||
    artifact.tarballBytes <= 0 ||
    !Number.isSafeInteger(artifact.unpackedBytes) ||
    artifact.unpackedBytes <= 0 ||
    artifact.syncAndAsync !== true ||
    artifact.rustToolchainRequired !== false ||
    JSON.stringify([...(artifact.formats ?? [])].sort()) !== JSON.stringify(['cjs', 'esm']) ||
    sizeGate?.schemaVersion !== 1 ||
    sizeGate.target !== artifact.target ||
    typeof sizeGate.profile !== 'string' ||
    !sizeGate.profile ||
    sizeGate.tarballBytes !== artifact.tarballBytes ||
    sizeGate.unpackedBytes !== artifact.unpackedBytes ||
    sizeGate.passed !== true ||
    !Array.isArray(sizeGate.violations) ||
    sizeGate.violations.length !== 0 ||
    !Number.isSafeInteger(sizeGate.maximumTarballBytes) ||
    sizeGate.maximumTarballBytes <= 0 ||
    !Number.isSafeInteger(sizeGate.maximumUnpackedBytes) ||
    sizeGate.maximumUnpackedBytes <= 0
  ) {
    throw new Error('Native package evidence is incomplete or exceeds its size budget')
  }
}

function validatePreviousCandidate(previous) {
  const { candidateDigest, ...payload } = previous
  const requiredDigests = [
    payload.workflowGateDigest,
    payload.shadowDigest,
    payload.benchmarkDigest,
    payload.runtimeDigest,
    payload.rollbackDigest,
    payload.nativePackageDigest,
  ]
  const hasValidChain =
    (payload.consecutiveGreenCandidates === 1 && payload.previousCandidateDigest === null) ||
    (payload.consecutiveGreenCandidates > 1 &&
      /^sha256:[0-9a-f]{64}$/.test(payload.previousCandidateDigest ?? ''))
  if (
    payload.schemaVersion !== 5 ||
    payload.status !== 'pass' ||
    payload.promotionEligible !== true ||
    payload.workflowEvent !== 'push' ||
    payload.sourceRef !== 'refs/heads/main' ||
    digest(payload) !== candidateDigest ||
    typeof payload.workflowGate !== 'object' ||
    payload.workflowGate === null ||
    digest(payload.workflowGate) !== payload.workflowGateDigest ||
    requiredDigests.some(value => !/^sha256:[0-9a-f]{64}$/.test(value ?? '')) ||
    !Number.isSafeInteger(payload.consecutiveGreenCandidates) ||
    payload.consecutiveGreenCandidates < 1 ||
    !hasValidChain ||
    typeof payload.runId !== 'string' ||
    !/^\d+$/.test(payload.runId) ||
    typeof payload.runAttempt !== 'string' ||
    !/^\d+$/.test(payload.runAttempt) ||
    !/^[0-9a-f]{40}$/.test(payload.sourceRevision ?? '') ||
    payload.compilerBuildRevision !== payload.sourceRevision ||
    typeof payload.compilerBuildId !== 'string' ||
    !payload.compilerBuildId
  ) {
    throw new Error('Previous candidate artifact is not a promotion-eligible schema-v5 candidate')
  }
  validateWorkflowGateArtifact(payload.workflowGate, payload)
}

const workflowGatePath = path.resolve(
  readArgument(
    'workflow-gate',
    path.join(root, '.fict-cache', 'compiler-rollout-workflow-gate.json'),
  ),
)
const shadowPath = path.resolve(
  readArgument('shadow', path.join(root, '.fict-cache', 'compiler-shadow.json')),
)
const benchmarkPath = path.resolve(
  readArgument('benchmark', path.join(root, '.fict-cache', 'compiler-backend-bench.json')),
)
const runtimePath = path.resolve(
  readArgument('runtime', path.join(root, '.fict-cache', 'compiler-runtime-parity.json')),
)
const rollbackPath = path.resolve(
  readArgument('rollback', path.join(root, '.fict-cache', 'compiler-rollback-drill.json')),
)
const nativePackagePath = path.resolve(
  readArgument('package', path.join(root, '.fict-cache', 'compiler-native-package.json')),
)
const outputPath = path.resolve(
  readArgument('output', path.join(root, '.fict-cache', 'compiler-rollout-candidate.json')),
)
const previousPath = readArgument('previous')
const runId = String(readArgument('run-id', process.env.GITHUB_RUN_ID ?? '')).trim()
const runAttempt = String(readArgument('run-attempt', process.env.GITHUB_RUN_ATTEMPT ?? '1')).trim()
const sourceRevision = String(
  readArgument('revision', process.env.GITHUB_SHA ?? gitRevision()),
).trim()
const workflowEvent = String(readArgument('event', process.env.GITHUB_EVENT_NAME ?? '')).trim()
const sourceRef = String(readArgument('ref', process.env.GITHUB_REF ?? '')).trim()

if (!/^\d+$/.test(runId)) {
  throw new Error('A numeric --run-id or GITHUB_RUN_ID is required for candidate evidence')
}
if (!/^\d+$/.test(runAttempt) || BigInt(runAttempt) < 1n) {
  throw new Error('Candidate run attempt must be a positive integer')
}
if (!/^[0-9a-f]{40}$/.test(sourceRevision))
  throw new Error('Candidate revision must be a git SHA-1')
if (!workflowEvent) throw new Error('Candidate workflow event is required')
if (!/^refs\//.test(sourceRef)) throw new Error('Candidate source ref must be a full Git ref')

const promotionEligible = workflowEvent === 'push' && sourceRef === 'refs/heads/main'

const workflowGate = readJson(workflowGatePath, 'Workflow gate artifact')
validateWorkflowGateArtifact(workflowGate, {
  runId,
  runAttempt,
  sourceRevision,
  workflowEvent,
  sourceRef,
})
const shadow = readJson(shadowPath, 'Shadow artifact')
const benchmark = readJson(benchmarkPath, 'Benchmark artifact')
const runtime = readJson(runtimePath, 'Runtime parity artifact')
const rollback = readJson(rollbackPath, 'Rollback drill artifact')
const nativePackage = readJson(nativePackagePath, 'Native package artifact')
validateShadow(shadow)
validateBenchmark(benchmark)
validateRuntime(runtime)
validateRollback(rollback)
validateNativePackage(nativePackage)

const compilerBuildIds = new Set([
  shadow.compilerBuildId,
  benchmark.compilerBuildId,
  runtime.compilerBuildId,
  rollback.compilerBuildId,
  nativePackage.compilerBuildId,
])
if (compilerBuildIds.size !== 1 || compilerBuildIds.has(undefined)) {
  throw new Error('Candidate artifacts were not produced by one native compiler build')
}
const compilerBuildRevisions = new Set([
  shadow.compilerBuildRevision,
  benchmark.compilerBuildRevision,
  runtime.compilerBuildRevision,
  rollback.compilerBuildRevision,
  nativePackage.compilerBuildRevision,
])
if (
  compilerBuildRevisions.size !== 1 ||
  compilerBuildRevisions.has(undefined) ||
  !compilerBuildRevisions.has(sourceRevision)
) {
  throw new Error('Candidate artifacts were not compiled from the candidate source revision')
}

let previous = null
if (previousPath) {
  if (!promotionEligible) {
    throw new Error('Only a main-branch push candidate may chain previous rollout evidence')
  }
  previous = readJson(path.resolve(previousPath), 'Previous candidate artifact')
  validatePreviousCandidate(previous)
  if (String(previous.runId) === runId && String(previous.runAttempt) === runAttempt) {
    throw new Error('Previous and current candidate builds must be distinct runs')
  }
  if (BigInt(runId) <= BigInt(previous.runId)) {
    throw new Error('Current GitHub run id must be newer than the previous candidate')
  }
}

const payload = {
  schemaVersion: 5,
  status: 'pass',
  runId,
  runAttempt,
  sourceRevision,
  workflowEvent,
  sourceRef,
  promotionEligible,
  compilerBuildId: [...compilerBuildIds][0],
  compilerBuildRevision: [...compilerBuildRevisions][0],
  workflowGate,
  workflowGateDigest: digest(workflowGate),
  shadowDigest: digest(shadow),
  benchmarkDigest: digest(benchmark),
  runtimeDigest: digest(runtime),
  rollbackDigest: digest(rollback),
  nativePackageDigest: digest(nativePackage),
  previousCandidateDigest: previous?.candidateDigest ?? null,
  consecutiveGreenCandidates: promotionEligible
    ? previous
      ? Number(previous.consecutiveGreenCandidates) + 1
      : 1
    : 0,
}
const candidate = { ...payload, candidateDigest: digest(payload) }

if (process.argv.includes('--require-two') && candidate.consecutiveGreenCandidates < 2) {
  throw new Error('Rust default requires two consecutive passing candidate builds')
}

await mkdir(path.dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(candidate, null, 2)}\n`, 'utf8')
process.stdout.write(
  `[compiler-rollout-candidate] ${candidate.consecutiveGreenCandidates} consecutive green ` +
    `promotion-eligible candidate(s); ${candidate.candidateDigest}.\n`,
)
