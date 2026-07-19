import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

const SHA256 = /^[0-9a-f]{64}$/
const GIT_REVISION = /^[0-9a-f]{40}$/

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function compilerCorpusIdentity(corpus, source = JSON.stringify(corpus)) {
  if (!isRecord(corpus) || corpus.schemaVersion !== 5) {
    throw new TypeError('frozen compiler corpus must be a schema v5 object')
  }
  if (!Array.isArray(corpus.fixtures) || corpus.fixtures.length === 0) {
    throw new TypeError('frozen compiler corpus must contain fixtures')
  }
  const provenance = corpus.provenance
  if (
    !isRecord(provenance) ||
    provenance.corpusFixtures !== corpus.fixtures.length ||
    !GIT_REVISION.test(provenance.reviewedRevision ?? '') ||
    typeof provenance.reviewedCompilerBuildId !== 'string' ||
    !provenance.reviewedCompilerBuildId
  ) {
    throw new TypeError('frozen compiler corpus provenance is incomplete')
  }
  return Object.freeze({
    schemaVersion: 1,
    corpusSchemaVersion: corpus.schemaVersion,
    corpusSha256: `sha256:${sha256(source)}`,
    fixtures: corpus.fixtures.length,
    reviewedRevision: provenance.reviewedRevision,
    reviewedCompilerBuildId: provenance.reviewedCompilerBuildId,
  })
}

function actualOutcome(result) {
  if (!isRecord(result) || typeof result.code !== 'string' || !Array.isArray(result.diagnostics)) {
    throw new TypeError('native compiler returned an invalid corpus result')
  }
  return {
    status: result.diagnostics.some(diagnostic => diagnostic?.severity === 'error')
      ? 'error'
      : 'ok',
    diagnostics: result.diagnostics.map(diagnostic => ({
      code: diagnostic.code,
      severity: diagnostic.severity,
      guaranteeClass: diagnostic.guaranteeClass,
    })),
    codeSha256: sha256(result.code),
  }
}

export function replayCompilerCorpus(binding, corpus, source = JSON.stringify(corpus)) {
  if (!isRecord(binding) || typeof binding.transformSync !== 'function') {
    throw new TypeError('compiler corpus replay requires a native transformSync binding')
  }
  const identity = compilerCorpusIdentity(corpus, source)

  for (const [index, fixture] of corpus.fixtures.entries()) {
    if (
      !isRecord(fixture) ||
      typeof fixture.id !== 'string' ||
      typeof fixture.source !== 'string' ||
      !isRecord(fixture.options) ||
      !isRecord(fixture.expected) ||
      !['ok', 'error'].includes(fixture.expected.status) ||
      !Array.isArray(fixture.expected.diagnostics) ||
      !SHA256.test(fixture.expected.codeSha256 ?? '')
    ) {
      throw new TypeError(`frozen compiler corpus fixture ${index} is invalid`)
    }

    let result
    try {
      result = binding.transformSync({
        protocolVersion: 1,
        code: fixture.source,
        filename: '/fixtures/legacy-0.28-corpus.tsx',
        options: fixture.options,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`frozen compiler corpus fixture ${fixture.id} threw: ${message}`, {
        cause: error,
      })
    }

    try {
      assert.deepEqual(actualOutcome(result), fixture.expected)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`frozen compiler corpus fixture ${fixture.id} diverged: ${message}`, {
        cause: error,
      })
    }
  }

  return identity
}
