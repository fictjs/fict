import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { compilerCorpusIdentity, replayCompilerCorpus } from './lib/compiler-corpus-replay.mjs'

const source = 'export const answer = 42;\n'
const codeSha256 = createHash('sha256').update(source).digest('hex')
const corpus = {
  schemaVersion: 5,
  provenance: {
    corpusFixtures: 1,
    reviewedRevision: 'a'.repeat(40),
    reviewedCompilerBuildId: 'fict-rust-test-build',
  },
  fixtures: [
    {
      id: 'fixture-1',
      source: 'export const answer: number = 42',
      options: { dev: true },
      expected: {
        status: 'ok',
        diagnostics: [],
        codeSha256,
      },
    },
  ],
}

test('replays the exact compiler request and returns a frozen corpus identity', () => {
  const requests = []
  const corpusSource = `${JSON.stringify(corpus, null, 2)}\n`
  const identity = replayCompilerCorpus(
    {
      transformSync(request) {
        requests.push(request)
        return { code: source, diagnostics: [] }
      },
    },
    corpus,
    corpusSource,
  )

  assert.deepEqual(requests, [
    {
      protocolVersion: 1,
      code: corpus.fixtures[0].source,
      filename: '/fixtures/legacy-0.28-corpus.tsx',
      options: { dev: true },
    },
  ])
  assert.deepEqual(identity, {
    schemaVersion: 1,
    corpusSchemaVersion: 5,
    corpusSha256: `sha256:${createHash('sha256').update(corpusSource).digest('hex')}`,
    fixtures: 1,
    reviewedRevision: 'a'.repeat(40),
    reviewedCompilerBuildId: 'fict-rust-test-build',
  })
})

test('fails closed on output, diagnostic, and provenance drift', () => {
  assert.throws(
    () =>
      replayCompilerCorpus({ transformSync: () => ({ code: 'changed', diagnostics: [] }) }, corpus),
    /fixture fixture-1 diverged/,
  )

  const invalidProvenance = structuredClone(corpus)
  invalidProvenance.provenance.corpusFixtures = 2
  assert.throws(() => compilerCorpusIdentity(invalidProvenance), /corpus provenance is incomplete/)
})
