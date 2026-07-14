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
    schemaVersion: 1,
    totalMaxLines: 30,
    defaultFileMaxLines: 4,
    crates: Object.fromEntries(EXPECTED_RUST_PACKAGES.map(crate => [crate, 5])),
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
  const budget = validBudget()
  budget.totalMaxLines = 20

  assert.deepEqual(evaluateRustCompilerComplexity(rows, budget).errors, [
    'crates/fict-compiler-oxc/src/lib.rs: 6 lines exceeds budget 4',
    'fict-compiler-oxc: 6 lines exceeds crate budget 5',
    'Rust compiler total: 22 lines exceeds budget 20',
  ])
})

test('requires the exact reviewed crate budget and source set', () => {
  const rows = validRows().filter(row => row.crate !== 'fict-metadata')
  rows.push({ crate: 'fict-unreviewed', file: 'crates/fict-unreviewed/src/lib.rs', lines: 1 })
  const budget = validBudget()
  delete budget.crates['fict-hir']
  budget.crates['fict-extra'] = 4

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
  budget.fileOverrides = {
    'crates/fict-compiler/src/lib.rs': 6,
    'crates/fict-hir/src/missing.rs': 8,
    'crates/fict-metadata/src/lib.rs': 4,
  }

  assert.deepEqual(evaluateRustCompilerComplexity(rows, budget).errors, [
    'Rust file budget references a missing source file: crates/fict-hir/src/missing.rs',
    'Rust file budget is no longer needed: crates/fict-metadata/src/lib.rs has 2 lines within default 4',
  ])
})

test('rejects malformed top-level and numeric budget values', () => {
  const budget = validBudget()
  budget.schemaVersion = 2
  budget.totalMaxLines = 0
  budget.defaultFileMaxLines = -1
  budget.crates['fict-hir'] = 1.5
  budget.fileOverrides['crates/fict-compiler/src/lib.rs'] = Number.NaN

  assert.deepEqual(evaluateRustCompilerComplexity(validRows(), budget).errors, [
    'Rust complexity budget schemaVersion must be 1',
    'Rust complexity totalMaxLines must be a positive integer',
    'Rust complexity defaultFileMaxLines must be a positive integer',
    'Rust crate budget must be a positive integer: fict-hir',
    'Rust file budget must be a positive integer: crates/fict-compiler/src/lib.rs',
  ])
})
