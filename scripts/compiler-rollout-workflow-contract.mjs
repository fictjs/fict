export const REQUIRED_ROLLOUT_JOBS = Object.freeze([
  'rust-fuzz',
  'rust-native',
  'compiler-rollout',
  'lint',
  'typecheck',
  'strict-guarantee',
  'perf-guardrails',
  'test',
  'e2e',
  'test-opt-out',
  'test-ssr-edge',
  'build',
])

const WORKFLOW_GATE_FIELDS = Object.freeze([
  'jobs',
  'repository',
  'runAttempt',
  'runId',
  'schemaVersion',
  'sourceRef',
  'sourceRevision',
  'status',
  'workflowEvent',
  'workflowJob',
  'workflowName',
])

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function validateWorkflowJobResults(jobs) {
  if (!isRecord(jobs)) throw new Error('Compiler rollout workflow jobs must be an object')
  const actualJobs = Object.keys(jobs).sort()
  const expectedJobs = [...REQUIRED_ROLLOUT_JOBS].sort()
  if (JSON.stringify(actualJobs) !== JSON.stringify(expectedJobs)) {
    throw new Error('Compiler rollout finalizer does not bind the exact required CI job set')
  }
  for (const job of REQUIRED_ROLLOUT_JOBS) {
    const result = jobs[job]
    const allowed = job === 'rust-fuzz' ? ['success', 'skipped'] : ['success']
    if (typeof result !== 'string' || !allowed.includes(result)) {
      throw new Error(`Compiler rollout CI job ${job} did not pass: ${String(result)}`)
    }
  }
}

export function validateWorkflowGateArtifact(artifact, expected = {}) {
  if (!isRecord(artifact)) throw new Error('Compiler rollout workflow gate must be an object')
  if (JSON.stringify(Object.keys(artifact).sort()) !== JSON.stringify(WORKFLOW_GATE_FIELDS)) {
    throw new Error('Compiler rollout workflow gate has an unsupported field shape')
  }
  if (artifact.schemaVersion !== 1 || artifact.status !== 'pass') {
    throw new Error('Compiler rollout workflow gate did not pass')
  }
  if (
    artifact.repository !== 'fictjs/fict' ||
    artifact.workflowName !== 'CI' ||
    artifact.workflowJob !== 'compiler-rollout-finalize'
  ) {
    throw new Error('Workflow gate must originate from the canonical Fict CI finalizer')
  }
  if (typeof artifact.runId !== 'string' || !/^\d+$/.test(artifact.runId)) {
    throw new Error('Workflow gate run id must be numeric')
  }
  if (
    typeof artifact.runAttempt !== 'string' ||
    !/^\d+$/.test(artifact.runAttempt) ||
    BigInt(artifact.runAttempt) < 1n
  ) {
    throw new Error('Workflow gate run attempt must be a positive integer')
  }
  if (!/^[0-9a-f]{40}$/.test(artifact.sourceRevision ?? '')) {
    throw new Error('Workflow gate source revision must be a git SHA-1')
  }
  if (typeof artifact.workflowEvent !== 'string' || !artifact.workflowEvent) {
    throw new Error('Workflow gate event is required')
  }
  if (!/^refs\//.test(artifact.sourceRef ?? '')) {
    throw new Error('Workflow gate source ref must be a full Git ref')
  }
  validateWorkflowJobResults(artifact.jobs)

  for (const field of ['runId', 'runAttempt', 'sourceRevision', 'workflowEvent', 'sourceRef']) {
    if (expected[field] !== undefined && String(artifact[field]) !== String(expected[field])) {
      throw new Error(`Compiler rollout workflow gate does not bind ${field}`)
    }
  }
}
