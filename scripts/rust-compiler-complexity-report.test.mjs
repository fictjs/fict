import assert from 'node:assert/strict'
import test from 'node:test'

import { EXPECTED_RUST_PACKAGES } from './check-rust-crate-boundaries.mjs'
import {
  countRustSourceLines,
  evaluateRustCompilerComplexity,
} from './rust-compiler-complexity-report.mjs'

function validRows() {
  return EXPECTED_RUST_PACKAGES.map(crate => ({
    crate,
    file: `crates/${crate}/src/lib.rs`,
    lines: 2,
  }))
}

function validBudget() {
  return {
    schemaVersion: 2,
    reservePolicy: {
      minimumTotalLines: 1,
      maximumTotalPercent: 100,
      minimumCrateLines: 1,
      maximumCratePercent: 100,
      minimumFileOverrideLines: 1,
      maximumFileOverridePercent: 100,
      totalRatchetReductionLines: 1,
      crateRatchetReductionLines: 1,
      fileOverrideRatchetReductionLines: 1,
    },
    total: { reviewedLines: 18, maxLines: 20 },
    defaultFileMaxLines: 4,
    crates: Object.fromEntries(
      EXPECTED_RUST_PACKAGES.map(crate => [crate, { reviewedLines: 2, maxLines: 3 }]),
    ),
    fileOverrides: {},
  }
}

test('counts empty, terminated, and unterminated Rust source lines', () => {
  assert.equal(countRustSourceLines(''), 0)
  assert.equal(countRustSourceLines('fn main() {}\n'), 1)
  assert.equal(countRustSourceLines('fn main() {}\n// tail'), 2)
  assert.equal(countRustSourceLines('fn main() {}\r\n// tail\r\n'), 2)
})

test('accepts the exact crate set within total, crate, and file budgets', () => {
  const result = evaluateRustCompilerComplexity(validRows(), validBudget())

  assert.deepEqual(result.errors, [])
  assert.equal(result.totalLines, 18)
  assert.equal(result.crateLines.get('fict-compiler-oxc'), 2)
})

test('rejects total, crate, and per-file growth independently', () => {
  const rows = validRows()
  rows.find(row => row.crate === 'fict-compiler-oxc').lines = 6

  assert.deepEqual(evaluateRustCompilerComplexity(rows, validBudget()).errors, [
    'crates/fict-compiler-oxc/src/lib.rs: 6 lines exceeds file ceiling 4',
    'fict-compiler-oxc: 6 lines exceeds crate ceiling 3',
    'Rust compiler total: 22 lines exceeds ceiling 20',
  ])
})

test('requires the exact reviewed crate budget and source set', () => {
  const rows = validRows().filter(row => row.crate !== 'fict-metadata')
  rows.push({ crate: 'fict-unreviewed', file: 'crates/fict-unreviewed/src/lib.rs', lines: 1 })
  const budget = validBudget()
  delete budget.crates['fict-hir']
  budget.crates['fict-extra'] = { reviewedLines: 1, maxLines: 2 }

  assert.deepEqual(evaluateRustCompilerComplexity(rows, budget).errors, [
    'Missing Rust crate complexity budget: fict-hir',
    'Unreviewed Rust crate complexity budget: fict-extra',
    'Missing Rust source crate: fict-metadata',
    'Unreviewed Rust source crate: fict-unreviewed',
  ])
})

test('rejects missing and stale oversized-file exceptions', () => {
  const rows = validRows()
  rows.find(row => row.crate === 'fict-compiler').lines = 5
  const budget = validBudget()
  budget.total = { reviewedLines: 21, maxLines: 22 }
  budget.crates['fict-compiler'] = { reviewedLines: 5, maxLines: 6 }
  budget.fileOverrides = {
    'crates/fict-compiler/src/lib.rs': {
      reviewedLines: 5,
      maxLines: 6,
      owner: 'Compiler request boundary',
      rationale: 'Keep this test fixture above the default ceiling.',
    },
    'crates/fict-hir/src/missing.rs': {
      reviewedLines: 8,
      maxLines: 9,
      owner: 'Missing test boundary',
      rationale: 'Exercise rejection of an override for a missing file.',
    },
    'crates/fict-metadata/src/lib.rs': {
      reviewedLines: 2,
      maxLines: 3,
      owner: 'Metadata test boundary',
      rationale: 'Exercise removal of a stale oversized-file exception.',
    },
  }

  assert.deepEqual(evaluateRustCompilerComplexity(rows, budget).errors, [
    'Rust file budget references a missing source file: crates/fict-hir/src/missing.rs',
    'Rust file budget is no longer needed: crates/fict-metadata/src/lib.rs has 2 lines within default 4',
  ])
})

test('rejects malformed top-level and numeric budget values', () => {
  const budget = validBudget()
  budget.schemaVersion = 1
  budget.reservePolicy.minimumTotalLines = 0
  budget.total.reviewedLines = 0
  budget.defaultFileMaxLines = -1
  budget.crates['fict-hir'].reviewedLines = 1.5
  budget.fileOverrides['crates/fict-compiler/src/lib.rs'] = {
    reviewedLines: 2,
    maxLines: Number.NaN,
    owner: '',
    rationale: 'short',
  }

  assert.deepEqual(evaluateRustCompilerComplexity(validRows(), budget).errors, [
    'Rust complexity budget schemaVersion must be 2',
    'Rust complexity reservePolicy.minimumTotalLines must be a positive integer',
    'Rust complexity defaultFileMaxLines must be a positive integer',
    'Rust compiler total reviewedLines must be a positive integer',
    'Rust crate fict-hir reviewedLines must be a positive integer',
    'Rust file crates/fict-compiler/src/lib.rs maxLines must be a positive integer',
    'Rust file budget owner must be a non-empty string: crates/fict-compiler/src/lib.rs',
    'Rust file budget rationale must contain at least 20 characters: crates/fict-compiler/src/lib.rs',
  ])
})

test('rejects snapshot ceilings without reserve and arbitrarily large reserve', () => {
  const rows = validRows()
  rows.find(row => row.crate === 'fict-compiler').lines = 5
  const budget = validBudget()
  budget.total = { reviewedLines: 21, maxLines: 21 }
  budget.crates['fict-compiler'] = { reviewedLines: 5, maxLines: 5 }
  budget.fileOverrides['crates/fict-compiler/src/lib.rs'] = {
    reviewedLines: 5,
    maxLines: 5,
    owner: 'Compiler request boundary',
    rationale: 'Exercise rejection of an exact snapshot file ceiling.',
  }

  assert.deepEqual(evaluateRustCompilerComplexity(rows, budget).errors, [
    'Rust compiler total reserve 0 lines is below policy minimum 1',
    'Rust crate fict-compiler reserve 0 lines is below policy minimum 1',
    'Rust file crates/fict-compiler/src/lib.rs reserve 0 lines is below policy minimum 1',
  ])

  budget.reservePolicy.maximumTotalPercent = 10
  budget.reservePolicy.maximumCratePercent = 10
  budget.reservePolicy.maximumFileOverridePercent = 10
  budget.total.maxLines = 25
  budget.crates['fict-compiler'].maxLines = 7
  budget.fileOverrides['crates/fict-compiler/src/lib.rs'].maxLines = 7

  assert.deepEqual(evaluateRustCompilerComplexity(rows, budget).errors, [
    'Rust compiler total reserve 4 lines exceeds policy maximum 3',
    'Rust crate fict-compiler reserve 2 lines exceeds policy maximum 1',
    'Rust file crates/fict-compiler/src/lib.rs reserve 2 lines exceeds policy maximum 1',
  ])
})

test('ratchets reviewed boundaries after material source reduction', () => {
  const rows = validRows()
  rows.find(row => row.crate === 'fict-compiler').lines = 5
  const budget = validBudget()
  budget.total = { reviewedLines: 22, maxLines: 24 }
  budget.crates['fict-compiler'] = { reviewedLines: 6, maxLines: 7 }
  budget.fileOverrides['crates/fict-compiler/src/lib.rs'] = {
    reviewedLines: 6,
    maxLines: 7,
    owner: 'Compiler request boundary',
    rationale: 'Exercise ratcheting after a material file reduction.',
  }

  assert.deepEqual(evaluateRustCompilerComplexity(rows, budget).errors, [
    'Rust compiler total reviewed baseline is stale: 21 lines is 1 below 22; ratchet after 1',
    'Rust crate fict-compiler reviewed baseline is stale: 5 lines is 1 below 6; ratchet after 1',
    'Rust file crates/fict-compiler/src/lib.rs reviewed baseline is stale: 5 lines is 1 below 6; ratchet after 1',
  ])
})
