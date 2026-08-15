#!/usr/bin/env node

/**
 * Compiler complexity guardrail.
 *
 * The TypeScript package is intentionally a thin native request/graph host.
 * Compiler passes belong in Rust, so deleted compatibility code must not leave
 * reusable TypeScript headroom behind.
 */
import fs from 'node:fs'
import path from 'node:path'

const compilerSrc = path.join(process.cwd(), 'packages/compiler/src')
const topLimit = Number(process.env.COMPILER_COMPLEXITY_TOP ?? 7)
const budgetPath = path.join(
  process.cwd(),
  process.env.COMPILER_COMPLEXITY_BUDGET ?? '.github/compiler-complexity-budget.json',
)

function toPosix(filePath) {
  return filePath.split(path.sep).join('/')
}

function countEffectiveSourceLines(text) {
  const normalized = text.endsWith('\n') ? text.slice(0, -1) : text
  if (normalized.length === 0) return 0

  let effectiveLines = 0
  let inBlockComment = false
  let stringQuote = null
  let escaped = false

  for (const line of normalized.split(/\r?\n/)) {
    let source = ''

    for (let index = 0; index < line.length; index++) {
      const char = line[index]
      const next = line[index + 1]

      if (inBlockComment) {
        if (char === '*' && next === '/') {
          inBlockComment = false
          index++
        }
        continue
      }

      if (stringQuote) {
        source += char
        if (escaped) {
          escaped = false
          continue
        }
        if (char === '\\') {
          escaped = true
          continue
        }
        if (char === stringQuote) {
          stringQuote = null
        }
        continue
      }

      if (char === '/' && next === '/') {
        break
      }
      if (char === '/' && next === '*') {
        inBlockComment = true
        index++
        continue
      }

      source += char
      if (char === "'" || char === '"' || char === '`') {
        stringQuote = char
        escaped = false
      }
    }

    if (source.trim().length > 0) {
      effectiveLines++
    }

    if (stringQuote !== '`') {
      stringQuote = null
      escaped = false
    }
  }

  return effectiveLines
}

function countEffectiveLines(filePath) {
  return countEffectiveSourceLines(fs.readFileSync(filePath, 'utf8'))
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const filePath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(filePath, out)
      continue
    }
    if (!entry.isFile()) continue
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) continue
    out.push(filePath)
  }
  return out
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0
}

function boundedPercentage(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 100
}

function validateReservePolicy(policy, failures) {
  if (!isRecord(policy)) {
    failures.push('Compiler complexity reservePolicy must be an object')
    return
  }
  for (const field of [
    'minimumTotalLines',
    'minimumFileOverrideLines',
    'totalRatchetReductionLines',
    'fileOverrideRatchetReductionLines',
  ]) {
    if (!positiveInteger(policy[field])) {
      failures.push(`Compiler complexity reservePolicy.${field} must be a positive integer`)
    }
  }
  for (const field of ['maximumTotalPercent', 'maximumFileOverridePercent']) {
    if (!boundedPercentage(policy[field])) {
      failures.push(`Compiler complexity reservePolicy.${field} must be a percentage in (0, 100]`)
    }
  }
}

function validateBoundary(
  label,
  boundary,
  observedLines,
  { minimumReserve, maximumReservePercent, ratchetReductionLines },
  failures,
) {
  if (!isRecord(boundary)) {
    failures.push(`${label} budget must be an object`)
    return
  }
  if (!positiveInteger(boundary.reviewedLines)) {
    failures.push(`${label} reviewedLines must be a positive integer`)
  }
  if (!positiveInteger(boundary.maxLines)) {
    failures.push(`${label} maxLines must be a positive integer`)
  }
  if (!positiveInteger(boundary.reviewedLines) || !positiveInteger(boundary.maxLines)) return

  const reserve = boundary.maxLines - boundary.reviewedLines
  if (positiveInteger(minimumReserve) && reserve < minimumReserve) {
    failures.push(`${label} reserve ${reserve} lines is below policy minimum ${minimumReserve}`)
  }
  if (boundedPercentage(maximumReservePercent)) {
    const maximumReserve = Math.ceil((boundary.reviewedLines * maximumReservePercent) / 100)
    if (reserve > maximumReserve) {
      failures.push(`${label} reserve ${reserve} lines exceeds policy maximum ${maximumReserve}`)
    }
  }
  if (
    positiveInteger(ratchetReductionLines) &&
    positiveInteger(observedLines) &&
    boundary.reviewedLines - observedLines >= ratchetReductionLines
  ) {
    failures.push(
      `${label} reviewed baseline is stale: ${observedLines} lines is ${boundary.reviewedLines - observedLines} below ${boundary.reviewedLines}; ratchet after ${ratchetReductionLines}`,
    )
  }
}

function main() {
  const budget = JSON.parse(fs.readFileSync(budgetPath, 'utf8'))
  const reservePolicy = budget?.reservePolicy ?? {}
  const fileOverrides = budget?.fileOverrides ?? {}
  const files = walk(compilerSrc)
  const rows = files
    .map(filePath => {
      const relative = toPosix(path.relative(process.cwd(), filePath))
      const boundary = fileOverrides[relative]
      return {
        file: relative,
        loc: countEffectiveLines(filePath),
        reviewed: boundary?.reviewedLines ?? null,
        ceiling: boundary?.maxLines ?? budget?.defaultFileMaxLines,
      }
    })
    .sort((a, b) => b.loc - a.loc)

  const totalLoc = rows.reduce((sum, row) => sum + row.loc, 0)
  const failures = []

  if (budget?.schemaVersion !== 2) {
    failures.push('Compiler complexity budget schemaVersion must be 2')
  }
  validateReservePolicy(budget?.reservePolicy, failures)
  if (!positiveInteger(budget?.defaultFileMaxLines)) {
    failures.push('Compiler complexity defaultFileMaxLines must be a positive integer')
  }
  validateBoundary(
    'Compiler total',
    budget?.total,
    totalLoc,
    {
      minimumReserve: reservePolicy.minimumTotalLines,
      maximumReservePercent: reservePolicy.maximumTotalPercent,
      ratchetReductionLines: reservePolicy.totalRatchetReductionLines,
    },
    failures,
  )

  const rowsByFile = new Map(rows.map(row => [row.file, row]))
  for (const [file, boundary] of Object.entries(fileOverrides).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const row = rowsByFile.get(file)
    validateBoundary(
      `Compiler file ${file}`,
      boundary,
      row?.loc,
      {
        minimumReserve: reservePolicy.minimumFileOverrideLines,
        maximumReservePercent: reservePolicy.maximumFileOverridePercent,
        ratchetReductionLines: reservePolicy.fileOverrideRatchetReductionLines,
      },
      failures,
    )
    if (typeof boundary?.owner !== 'string' || boundary.owner.trim().length === 0) {
      failures.push(`Compiler file budget owner must be a non-empty string: ${file}`)
    }
    if (typeof boundary?.rationale !== 'string' || boundary.rationale.trim().length < 20) {
      failures.push(`Compiler file budget rationale must contain at least 20 characters: ${file}`)
    }
    if (!row) {
      failures.push(`Compiler file budget references a missing source file: ${file}`)
    }
  }

  for (const row of rows) {
    if (positiveInteger(row.ceiling) && row.loc > row.ceiling) {
      failures.push(`${row.file}: ${row.loc} effective LOC exceeds ceiling ${row.ceiling}`)
    }
  }

  if (positiveInteger(budget?.total?.maxLines) && totalLoc > budget.total.maxLines) {
    failures.push(
      `compiler src total: ${totalLoc} effective LOC exceeds ceiling ${budget.total.maxLines}`,
    )
  }

  console.log(`Compiler source files: ${rows.length}`)
  console.log(
    `Compiler effective source LOC: ${totalLoc} / ${budget?.total?.maxLines} (${budget?.total?.maxLines - totalLoc} reserve)`,
  )
  console.log('Largest compiler files:')
  console.table(
    rows.slice(0, topLimit).map(row => ({
      file: row.file,
      effectiveLoc: row.loc,
      reviewed: row.reviewed,
      ceiling: row.ceiling,
      remaining: row.ceiling - row.loc,
    })),
  )

  if (failures.length > 0) {
    console.error('Compiler complexity budget failures:')
    for (const failure of failures) {
      console.error(`- ${failure}`)
    }
    process.exitCode = 1
  }
}

try {
  main()
} catch (error) {
  console.error('[compiler-complexity] Failed:', error)
  process.exitCode = 1
}
