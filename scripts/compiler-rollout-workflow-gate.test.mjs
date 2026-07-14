import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { REQUIRED_ROLLOUT_JOBS } from './compiler-rollout-workflow-contract.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const script = path.join(root, 'scripts', 'compiler-rollout-workflow-gate.mjs')

function needs(overrides = {}) {
  return Object.fromEntries(
    REQUIRED_ROLLOUT_JOBS.map(job => [
      job,
      {
        result: job === 'rust-fuzz' ? 'skipped' : 'success',
        outputs: { ignored: 'not copied into evidence' },
        ...overrides[job],
      },
    ]),
  )
}

function run(output, workflowNeeds, env = {}) {
  return spawnSync(process.execPath, [script, `--output=${output}`], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      COMPILER_ROLLOUT_NEEDS: JSON.stringify(workflowNeeds),
      GITHUB_RUN_ID: '101',
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_SHA: 'a'.repeat(40),
      GITHUB_EVENT_NAME: 'push',
      GITHUB_REF: 'refs/heads/main',
      GITHUB_REPOSITORY: 'fictjs/fict',
      GITHUB_WORKFLOW: 'CI',
      GITHUB_JOB: 'compiler-rollout-finalize',
      ...env,
    },
  })
}

test('workflow gate records only validated job results and run identity', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fict-workflow-gate-'))
  t.after(() => rm(directory, { recursive: true }))
  const output = path.join(directory, 'gate.json')
  const result = run(output, needs())
  assert.equal(result.status, 0, result.stderr)

  const artifact = JSON.parse(await readFile(output, 'utf8'))
  assert.equal(artifact.schemaVersion, 1)
  assert.equal(artifact.status, 'pass')
  assert.equal(artifact.workflowJob, 'compiler-rollout-finalize')
  assert.deepEqual(Object.keys(artifact.jobs), REQUIRED_ROLLOUT_JOBS)
  assert.equal(artifact.jobs['rust-fuzz'], 'skipped')
  assert.equal(JSON.stringify(artifact).includes('ignored'), false)
})

test('workflow gate rejects failed or missing required jobs', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fict-workflow-gate-'))
  t.after(() => rm(directory, { recursive: true }))
  const failed = run(path.join(directory, 'failed.json'), needs({ e2e: { result: 'failure' } }))
  assert.notEqual(failed.status, 0)
  assert.match(failed.stderr, /e2e did not pass: failure/)

  const missing = needs()
  delete missing['test-ssr-edge']
  const incomplete = run(path.join(directory, 'missing.json'), missing)
  assert.notEqual(incomplete.status, 0)
  assert.match(incomplete.stderr, /exact required CI job set/)
})

test('workflow gate rejects a noncanonical workflow or producer job', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fict-workflow-gate-'))
  t.after(() => rm(directory, { recursive: true }))
  const fork = run(path.join(directory, 'fork.json'), needs(), {
    GITHUB_REPOSITORY: 'fork/fict',
  })
  assert.notEqual(fork.status, 0)
  assert.match(fork.stderr, /canonical Fict CI workflow/)

  const wrongJob = run(path.join(directory, 'job.json'), needs(), {
    GITHUB_JOB: 'compiler-rollout',
  })
  assert.notEqual(wrongJob.status, 0)
  assert.match(wrongJob.stderr, /rollout finalizer job/)
})
