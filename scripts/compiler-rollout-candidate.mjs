#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

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
    artifact.schemaVersion !== 1 ||
    artifact.backend !== 'shadow' ||
    artifact.summary?.modules < 1 ||
    artifact.summary?.unexplainedDifferences !== 0
  ) {
    throw new Error('Shadow artifact is missing modules or contains unexplained differences')
  }
}

function validateBenchmark(artifact) {
  if (artifact.schemaVersion !== 1 || artifact.status !== 'pass' || artifact.violations?.length) {
    throw new Error('Compiler backend benchmark did not pass its performance/RSS budgets')
  }
}

function validateRuntime(artifact) {
  if (
    artifact.schemaVersion !== 1 ||
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
    artifact.schemaVersion !== 1 ||
    artifact.status !== 'pass' ||
    artifact.rollbackUnit !== 'whole-build' ||
    Object.values(artifact.purged ?? {}).length !== 4 ||
    Object.values(artifact.purged ?? {}).some(value => value !== true)
  ) {
    throw new Error('Whole-build rollback drill evidence is incomplete')
  }
}

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
const outputPath = path.resolve(
  readArgument('output', path.join(root, '.fict-cache', 'compiler-rollout-candidate.json')),
)
const previousPath = readArgument('previous')
const runId = String(readArgument('run-id', process.env.GITHUB_RUN_ID ?? '')).trim()
const runAttempt = String(readArgument('run-attempt', process.env.GITHUB_RUN_ATTEMPT ?? '1')).trim()
const sourceRevision = String(
  readArgument('revision', process.env.GITHUB_SHA ?? gitRevision()),
).trim()

if (!/^\d+$/.test(runId)) {
  throw new Error('A numeric --run-id or GITHUB_RUN_ID is required for candidate evidence')
}
if (!/^\d+$/.test(runAttempt) || BigInt(runAttempt) < 1n) {
  throw new Error('Candidate run attempt must be a positive integer')
}
if (!/^[0-9a-f]{40}$/.test(sourceRevision))
  throw new Error('Candidate revision must be a git SHA-1')

const shadow = readJson(shadowPath, 'Shadow artifact')
const benchmark = readJson(benchmarkPath, 'Benchmark artifact')
const runtime = readJson(runtimePath, 'Runtime parity artifact')
const rollback = readJson(rollbackPath, 'Rollback drill artifact')
validateShadow(shadow)
validateBenchmark(benchmark)
validateRuntime(runtime)
validateRollback(rollback)

const compilerBuildIds = new Set([
  shadow.compilerBuildId,
  benchmark.compilerBuildId,
  runtime.compilerBuildId,
  rollback.compilerBuildId,
])
if (compilerBuildIds.size !== 1 || compilerBuildIds.has(undefined)) {
  throw new Error('Candidate artifacts were not produced by one native compiler build')
}

let previous = null
if (previousPath) {
  previous = readJson(path.resolve(previousPath), 'Previous candidate artifact')
  if (
    previous.schemaVersion !== 1 ||
    previous.status !== 'pass' ||
    !/^sha256:[0-9a-f]{64}$/.test(previous.candidateDigest ?? '') ||
    !Number.isSafeInteger(previous.consecutiveGreenCandidates) ||
    previous.consecutiveGreenCandidates < 1 ||
    !/^\d+$/.test(String(previous.runId)) ||
    !/^\d+$/.test(String(previous.runAttempt))
  ) {
    throw new Error('Previous candidate artifact is not a passing schema-v1 candidate')
  }
  if (String(previous.runId) === runId && String(previous.runAttempt) === runAttempt) {
    throw new Error('Previous and current candidate builds must be distinct runs')
  }
  if (BigInt(runId) <= BigInt(previous.runId)) {
    throw new Error('Current GitHub run id must be newer than the previous candidate')
  }
}

const payload = {
  schemaVersion: 1,
  status: 'pass',
  runId,
  runAttempt,
  sourceRevision,
  compilerBuildId: [...compilerBuildIds][0],
  shadowDigest: digest(shadow),
  benchmarkDigest: digest(benchmark),
  runtimeDigest: digest(runtime),
  rollbackDigest: digest(rollback),
  previousCandidateDigest: previous?.candidateDigest ?? null,
  consecutiveGreenCandidates: previous
    ? Math.max(2, Number(previous.consecutiveGreenCandidates ?? 1) + 1)
    : 1,
}
const candidate = { ...payload, candidateDigest: digest(payload) }

if (process.argv.includes('--require-two') && candidate.consecutiveGreenCandidates < 2) {
  throw new Error('Rust default requires two consecutive passing candidate builds')
}

await mkdir(path.dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(candidate, null, 2)}\n`, 'utf8')
process.stdout.write(
  `[compiler-rollout-candidate] ${candidate.consecutiveGreenCandidates} consecutive green ` +
    `candidate(s); ${candidate.candidateDigest}.\n`,
)
