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

function boundedPercentage(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 100
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sortedDifference(left, right) {
  return [...left].filter(value => !right.has(value)).sort()
}

function validateReservePolicy(policy, errors) {
  const integerFields = [
    'minimumTotalLines',
    'minimumCrateLines',
    'minimumFileOverrideLines',
    'totalRatchetReductionLines',
    'crateRatchetReductionLines',
    'fileOverrideRatchetReductionLines',
  ]
  const percentageFields = [
    'maximumTotalPercent',
    'maximumCratePercent',
    'maximumFileOverridePercent',
  ]
  if (!isRecord(policy)) {
    errors.push('Rust complexity reservePolicy must be an object')
    return
  }
  for (const field of integerFields) {
    if (!positiveInteger(policy[field])) {
      errors.push(`Rust complexity reservePolicy.${field} must be a positive integer`)
    }
  }
  for (const field of percentageFields) {
    if (!boundedPercentage(policy[field])) {
      errors.push(`Rust complexity reservePolicy.${field} must be a percentage in (0, 100]`)
    }
  }
}

function validateReviewedBoundary(
  label,
  boundary,
  observedLines,
  { minimumReserve, maximumReservePercent, ratchetReductionLines },
  errors,
) {
  if (!isRecord(boundary)) {
    errors.push(`${label} budget must be an object`)
    return
  }
  if (!positiveInteger(boundary.reviewedLines)) {
    errors.push(`${label} reviewedLines must be a positive integer`)
  }
  if (!positiveInteger(boundary.maxLines)) {
    errors.push(`${label} maxLines must be a positive integer`)
  }
  if (!positiveInteger(boundary.reviewedLines) || !positiveInteger(boundary.maxLines)) return

  const reserve = boundary.maxLines - boundary.reviewedLines
  if (positiveInteger(minimumReserve) && reserve < minimumReserve) {
    errors.push(`${label} reserve ${reserve} lines is below policy minimum ${minimumReserve}`)
  }
  if (boundedPercentage(maximumReservePercent)) {
    const maximumReserve = Math.ceil((boundary.reviewedLines * maximumReservePercent) / 100)
    if (reserve > maximumReserve) {
      errors.push(`${label} reserve ${reserve} lines exceeds policy maximum ${maximumReserve}`)
    }
  }
  if (
    positiveInteger(ratchetReductionLines) &&
    positiveInteger(observedLines) &&
    boundary.reviewedLines - observedLines >= ratchetReductionLines
  ) {
    errors.push(
      `${label} reviewed baseline is stale: ${observedLines} lines is ${boundary.reviewedLines - observedLines} below ${boundary.reviewedLines}; ratchet after ${ratchetReductionLines}`,
    )
  }
}

function boundaryMaxLines(boundary) {
  return isRecord(boundary) ? boundary.maxLines : undefined
}

export function evaluateRustCompilerComplexity(rows, budget) {
  const errors = []
  const expectedCrates = new Set(EXPECTED_RUST_PACKAGES)
  const budgetCrates = new Set(Object.keys(budget?.crates ?? {}))
  const observedCrates = new Set(rows.map(row => row.crate))
  const overrides = budget?.fileOverrides ?? {}
  const reservePolicy = budget?.reservePolicy ?? {}
  const rowsByFile = new Map(rows.map(row => [row.file, row]))

  if (budget?.schemaVersion !== 2) {
    errors.push('Rust complexity budget schemaVersion must be 2')
  }
  validateReservePolicy(budget?.reservePolicy, errors)
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

  const crateLines = new Map(EXPECTED_RUST_PACKAGES.map(crate => [crate, 0]))
  for (const row of rows) {
    crateLines.set(row.crate, (crateLines.get(row.crate) ?? 0) + row.lines)
  }
  const totalLines = rows.reduce((total, row) => total + row.lines, 0)

  validateReviewedBoundary(
    'Rust compiler total',
    budget?.total,
    observedCrates.size === expectedCrates.size &&
      sortedDifference(expectedCrates, observedCrates).length === 0 &&
      sortedDifference(observedCrates, expectedCrates).length === 0
      ? totalLines
      : undefined,
    {
      minimumReserve: reservePolicy.minimumTotalLines,
      maximumReservePercent: reservePolicy.maximumTotalPercent,
      ratchetReductionLines: reservePolicy.totalRatchetReductionLines,
    },
    errors,
  )

  for (const [crate, boundary] of Object.entries(budget?.crates ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    validateReviewedBoundary(
      `Rust crate ${crate}`,
      boundary,
      observedCrates.has(crate) ? crateLines.get(crate) : undefined,
      {
        minimumReserve: reservePolicy.minimumCrateLines,
        maximumReservePercent: reservePolicy.maximumCratePercent,
        ratchetReductionLines: reservePolicy.crateRatchetReductionLines,
      },
      errors,
    )
  }
  for (const [file, boundary] of Object.entries(overrides).sort(([a], [b]) => a.localeCompare(b))) {
    const row = rowsByFile.get(file)
    validateReviewedBoundary(
      `Rust file ${file}`,
      boundary,
      row?.lines,
      {
        minimumReserve: reservePolicy.minimumFileOverrideLines,
        maximumReservePercent: reservePolicy.maximumFileOverridePercent,
        ratchetReductionLines: reservePolicy.fileOverrideRatchetReductionLines,
      },
      errors,
    )
    if (typeof boundary?.owner !== 'string' || boundary.owner.trim().length === 0) {
      errors.push(`Rust file budget owner must be a non-empty string: ${file}`)
    }
    if (typeof boundary?.rationale !== 'string' || boundary.rationale.trim().length < 20) {
      errors.push(`Rust file budget rationale must contain at least 20 characters: ${file}`)
    }
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

  for (const row of rows) {
    const maxLines = boundaryMaxLines(overrides[row.file]) ?? budget?.defaultFileMaxLines
    if (positiveInteger(maxLines) && row.lines > maxLines) {
      errors.push(`${row.file}: ${row.lines} lines exceeds file ceiling ${maxLines}`)
    }
  }

  for (const crate of EXPECTED_RUST_PACKAGES) {
    const lines = crateLines.get(crate) ?? 0
    const maxLines = boundaryMaxLines(budget?.crates?.[crate])
    if (positiveInteger(maxLines) && lines > maxLines) {
      errors.push(`${crate}: ${lines} lines exceeds crate ceiling ${maxLines}`)
    }
  }

  const totalMaxLines = boundaryMaxLines(budget?.total)
  if (positiveInteger(totalMaxLines) && totalLines > totalMaxLines) {
    errors.push(`Rust compiler total: ${totalLines} lines exceeds ceiling ${totalMaxLines}`)
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
  console.log(
    `Rust source lines: ${result.totalLines} / ${budget.total.maxLines} (${budget.total.maxLines - result.totalLines} reserve)`,
  )
  console.log('Rust crate source lines:')
  console.table(
    EXPECTED_RUST_PACKAGES.map(crate => ({
      crate,
      lines: result.crateLines.get(crate) ?? 0,
      reviewed: budget.crates[crate].reviewedLines,
      ceiling: budget.crates[crate].maxLines,
      remaining: budget.crates[crate].maxLines - (result.crateLines.get(crate) ?? 0),
    })),
  )
  console.log('Largest Rust source files:')
  console.table(
    largest.map(row => ({
      file: row.file,
      lines: row.lines,
      reviewed: budget.fileOverrides[row.file]?.reviewedLines ?? null,
      ceiling: budget.fileOverrides[row.file]?.maxLines ?? budget.defaultFileMaxLines,
      remaining:
        (budget.fileOverrides[row.file]?.maxLines ?? budget.defaultFileMaxLines) - row.lines,
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
