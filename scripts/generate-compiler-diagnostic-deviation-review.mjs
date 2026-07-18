#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { format, resolveConfig } from 'prettier'

import {
  buildDiagnosticDeviationReview,
  corpusDiagnosticReviewFixtures,
} from './lib/compiler-diagnostic-deviation-review.mjs'

const repositoryRoot = path.resolve(import.meta.dirname, '..')
const corpusPath = path.join(
  repositoryRoot,
  'crates/fict-compiler/tests/rust_frozen_codegen_corpus.json',
)
const defaultOutput = path.join(
  repositoryRoot,
  'scripts/fixtures/compiler_diagnostic_deviation_reviews.json',
)

function outputPath(argv) {
  if (argv.length === 0) return defaultOutput
  if (argv.length === 2 && argv[0] === '--output') return path.resolve(argv[1])
  throw new Error('Usage: generate-compiler-diagnostic-deviation-review.mjs [--output path]')
}

const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'))
const review = buildDiagnosticDeviationReview({
  sourceAuditSha256: corpus.provenance.auditInputSha256,
  fixtures: corpusDiagnosticReviewFixtures(corpus),
})
const output = outputPath(process.argv.slice(2))
writeFileSync(
  output,
  await format(JSON.stringify(review, null, 2), {
    ...(await resolveConfig(defaultOutput)),
    filepath: defaultOutput,
    parser: 'json',
  }),
)
process.stdout.write(
  `${JSON.stringify({ output, deviationCount: review.deviationCount, policyCounts: review.policyCounts })}\n`,
)
