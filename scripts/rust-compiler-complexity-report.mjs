#!/usr/bin/env node

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { EXPECTED_RUST_PACKAGES } from './check-rust-crate-boundaries.mjs'

const DEFAULT_BUDGET_PATH = '.github/rust-compiler-complexity-budget.json'

function toPosix(filePath) {
  return filePath.split(path.sep).join('/')
}

export function countRustSourceLines(source) {
  if (source.length === 0) return 0
  const lines = source.split(/\r?\n/u)
  return lines.length - (lines.at(-1) === '' ? 1 : 0)
}

function collectRustFiles(directory, rootDirectory, rows = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      collectRustFiles(entryPath, rootDirectory, rows)
    } else if (entry.isFile() && entry.name.endsWith('.rs')) {
      const relative = toPosix(path.relative(rootDirectory, entryPath))
      const [, crate] = relative.split('/')
      rows.push({
        crate,
        file: relative,
        lines: countRustSourceLines(readFileSync(entryPath, 'utf8')),
      })
    }
  }
  return rows
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0
}

function sortedDifference(left, right) {
  return [...left].filter(value => !right.has(value)).sort()
}

export function evaluateRustCompilerComplexity(rows, budget) {
  const errors = []
  const expectedCrates = new Set(EXPECTED_RUST_PACKAGES)
  const budgetCrates = new Set(Object.keys(budget?.crates ?? {}))
  const observedCrates = new Set(rows.map(row => row.crate))
  const overrides = budget?.fileOverrides ?? {}
  const rowsByFile = new Map(rows.map(row => [row.file, row]))

  if (budget?.schemaVersion !== 1) {
    errors.push('Rust complexity budget schemaVersion must be 1')
  }
  if (!positiveInteger(budget?.totalMaxLines)) {
    errors.push('Rust complexity totalMaxLines must be a positive integer')
  }
  if (!positiveInteger(budget?.defaultFileMaxLines)) {
    errors.push('Rust complexity defaultFileMaxLines must be a positive integer')
  }

  for (const crate of sortedDifference(expectedCrates, budgetCrates)) {
    errors.push(`Missing Rust crate complexity budget: ${crate}`)
  }
  for (const crate of sortedDifference(budgetCrates, expectedCrates)) {
    errors.push(`Unreviewed Rust crate complexity budget: ${crate}`)
  }
  for (const crate of sortedDifference(expectedCrates, observedCrates)) {
    errors.push(`Missing Rust source crate: ${crate}`)
  }
  for (const crate of sortedDifference(observedCrates, expectedCrates)) {
    errors.push(`Unreviewed Rust source crate: ${crate}`)
  }

  for (const [crate, maxLines] of Object.entries(budget?.crates ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (!positiveInteger(maxLines)) {
      errors.push(`Rust crate budget must be a positive integer: ${crate}`)
    }
  }
  for (const [file, maxLines] of Object.entries(overrides).sort(([a], [b]) => a.localeCompare(b))) {
    if (!positiveInteger(maxLines)) {
      errors.push(`Rust file budget must be a positive integer: ${file}`)
    }
    const row = rowsByFile.get(file)
    if (!row) {
      errors.push(`Rust file budget references a missing source file: ${file}`)
    } else if (
      positiveInteger(budget?.defaultFileMaxLines) &&
      row.lines <= budget.defaultFileMaxLines
    ) {
      errors.push(
        `Rust file budget is no longer needed: ${file} has ${row.lines} lines within default ${budget.defaultFileMaxLines}`,
      )
    }
  }

  const crateLines = new Map(EXPECTED_RUST_PACKAGES.map(crate => [crate, 0]))
  for (const row of rows) {
    crateLines.set(row.crate, (crateLines.get(row.crate) ?? 0) + row.lines)
    const maxLines = overrides[row.file] ?? budget?.defaultFileMaxLines
    if (positiveInteger(maxLines) && row.lines > maxLines) {
      errors.push(`${row.file}: ${row.lines} lines exceeds budget ${maxLines}`)
    }
  }

  for (const crate of EXPECTED_RUST_PACKAGES) {
    const lines = crateLines.get(crate) ?? 0
    const maxLines = budget?.crates?.[crate]
    if (positiveInteger(maxLines) && lines > maxLines) {
      errors.push(`${crate}: ${lines} lines exceeds crate budget ${maxLines}`)
    }
  }

  const totalLines = rows.reduce((total, row) => total + row.lines, 0)
  if (positiveInteger(budget?.totalMaxLines) && totalLines > budget.totalMaxLines) {
    errors.push(`Rust compiler total: ${totalLines} lines exceeds budget ${budget.totalMaxLines}`)
  }

  return { crateLines, errors, totalLines }
}

export function runRustCompilerComplexityReport(rootDirectory = process.cwd()) {
  const budgetPath = path.join(rootDirectory, DEFAULT_BUDGET_PATH)
  const budget = JSON.parse(readFileSync(budgetPath, 'utf8'))
  const rows = collectRustFiles(path.join(rootDirectory, 'crates'), rootDirectory).sort((a, b) =>
    a.file.localeCompare(b.file),
  )
  const result = evaluateRustCompilerComplexity(rows, budget)
  const largest = [...rows].sort((a, b) => b.lines - a.lines).slice(0, 12)

  console.log(`Rust source files: ${rows.length}`)
  console.log(`Rust source lines: ${result.totalLines} / ${budget.totalMaxLines}`)
  console.log('Rust crate source lines:')
  console.table(
    EXPECTED_RUST_PACKAGES.map(crate => ({
      crate,
      lines: result.crateLines.get(crate) ?? 0,
      budget: budget.crates[crate],
    })),
  )
  console.log('Largest Rust source files:')
  console.table(
    largest.map(row => ({
      file: row.file,
      lines: row.lines,
      budget: budget.fileOverrides[row.file] ?? budget.defaultFileMaxLines,
    })),
  )

  if (result.errors.length > 0) {
    throw new Error(`Rust compiler complexity check failed:\n- ${result.errors.join('\n- ')}`)
  }

  return result
}

const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  try {
    runRustCompilerComplexityReport()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
