#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  REQUIRED_ROLLOUT_JOBS,
  validateWorkflowGateArtifact,
} from './compiler-rollout-workflow-contract.mjs'
import { assertCliArguments } from './strict-cli-arguments.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
assertCliArguments(process.argv.slice(2), {
  command: 'compiler rollout workflow gate',
  valueArguments: ['output', 'needs-json'],
})

function readArgument(name, fallback) {
  const prefix = `--${name}=`
  const inline = process.argv.find(argument => argument.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required to seal the workflow gate`)
  return value
}

const outputPath = path.resolve(
  readArgument('output', path.join(root, '.fict-cache', 'compiler-rollout-workflow-gate.json')),
)
const needsSource = readArgument('needs-json', process.env.COMPILER_ROLLOUT_NEEDS)
if (!needsSource) throw new Error('COMPILER_ROLLOUT_NEEDS or --needs-json is required')

let needs
try {
  needs = JSON.parse(needsSource)
} catch {
  throw new Error('Compiler rollout workflow needs must be valid JSON')
}
if (!isRecord(needs)) throw new Error('Compiler rollout workflow needs must be an object')

const actualJobs = Object.keys(needs).sort()
const expectedJobs = [...REQUIRED_ROLLOUT_JOBS].sort()
if (JSON.stringify(actualJobs) !== JSON.stringify(expectedJobs)) {
  throw new Error('Compiler rollout finalizer does not depend on the exact required CI job set')
}

const jobs = {}
for (const job of REQUIRED_ROLLOUT_JOBS) {
  const entry = needs[job]
  if (!isRecord(entry) || typeof entry.result !== 'string') {
    throw new Error(`Compiler rollout CI result is missing for ${job}`)
  }
  const allowed = job === 'rust-fuzz' ? ['success', 'skipped'] : ['success']
  if (!allowed.includes(entry.result)) {
    throw new Error(`Compiler rollout CI job ${job} did not pass: ${entry.result}`)
  }
  jobs[job] = entry.result
}

const runId = requiredEnvironment('GITHUB_RUN_ID')
const runAttempt = requiredEnvironment('GITHUB_RUN_ATTEMPT')
const sourceRevision = requiredEnvironment('GITHUB_SHA')
const workflowEvent = requiredEnvironment('GITHUB_EVENT_NAME')
const sourceRef = requiredEnvironment('GITHUB_REF')
const repository = requiredEnvironment('GITHUB_REPOSITORY')
const workflowName = requiredEnvironment('GITHUB_WORKFLOW')
const workflowJob = requiredEnvironment('GITHUB_JOB')

if (!/^\d+$/.test(runId)) throw new Error('Workflow gate run id must be numeric')
if (!/^\d+$/.test(runAttempt) || BigInt(runAttempt) < 1n) {
  throw new Error('Workflow gate run attempt must be a positive integer')
}
if (!/^[0-9a-f]{40}$/.test(sourceRevision)) {
  throw new Error('Workflow gate source revision must be a git SHA-1')
}
if (!/^refs\//.test(sourceRef)) throw new Error('Workflow gate source ref must be a full Git ref')
if (repository !== 'fictjs/fict' || workflowName !== 'CI') {
  throw new Error('Workflow gate must originate from the canonical Fict CI workflow')
}
if (workflowJob !== 'compiler-rollout-finalize') {
  throw new Error('Workflow gate must be produced by the rollout finalizer job')
}

const artifact = {
  schemaVersion: 1,
  status: 'pass',
  repository,
  workflowName,
  workflowJob,
  runId,
  runAttempt,
  sourceRevision,
  workflowEvent,
  sourceRef,
  jobs,
}
validateWorkflowGateArtifact(artifact)

await mkdir(path.dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
process.stdout.write(
  `[compiler-rollout-workflow-gate] ${REQUIRED_ROLLOUT_JOBS.length} required CI jobs passed.\n`,
)
