#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const review = JSON.parse(
  readFileSync(path.join(root, 'scripts/fixtures/compiler_rust_acceptance_reviews.json'), 'utf8'),
)
const corpus = JSON.parse(
  readFileSync(
    path.join(root, 'crates/fict-compiler/tests/rust_frozen_codegen_corpus.json'),
    'utf8',
  ),
)
const acceptancePolicies = new Set(Object.keys(review.policies))
const corpusAcceptances = corpus.fixtures.filter(fixture =>
  acceptancePolicies.has(fixture.deviationPolicy),
)
assert.deepEqual(
  corpusAcceptances.map(fixture => fixture.id).sort(),
  review.reviews.map(entry => entry.id).sort(),
  'Rust acceptance review and frozen corpus must cover the same fixtures',
)
const blocking = corpusAcceptances.filter(
  fixture => review.policies[fixture.deviationPolicy]?.releaseDisposition === 'block',
)

if (blocking.length > 0) {
  const details = blocking.map(fixture => `- ${fixture.id}: ${fixture.deviationPolicy}`).join('\n')
  throw new Error(
    `Rust acceptance review contains ${blocking.length} release-blocking regression(s):\n${details}`,
  )
}

process.stdout.write(
  `${JSON.stringify({ reviewed: review.reviews.length, releaseBlocking: blocking.length })}\n`,
)
