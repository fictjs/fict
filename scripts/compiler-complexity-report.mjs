#!/usr/bin/env node

/**
 * Compiler complexity guardrail.
 *
 * The compiler intentionally has deep IR/codegen machinery, but large files
 * need an explicit budget so refactors are driven by data instead of surprise.
 */
import fs from 'node:fs'
import path from 'node:path'

const compilerSrc = path.join(process.cwd(), 'packages/compiler/src')
const topLimit = Number(process.env.COMPILER_COMPLEXITY_TOP ?? 12)
const defaultMaxLoc = Number(process.env.COMPILER_COMPLEXITY_MAX_LOC ?? 1600)
const totalMaxLoc = Number(process.env.COMPILER_COMPLEXITY_TOTAL_LOC ?? 56029)

const fileBudgets = new Map([
  ['packages/compiler/src/ir/codegen.ts', 9691],
  ['packages/compiler/src/ir/optimize.ts', 7391],
  ['packages/compiler/src/ir/regions.ts', 7129],
  ['packages/compiler/src/index.ts', 4677],
  ['packages/compiler/src/ir/build-hir.ts', 3611],
  ['packages/compiler/src/ir/structurize.ts', 1602],
])

function toPosix(filePath) {
  return filePath.split(path.sep).join('/')
}

function isEffectiveSourceLine(line) {
  const trimmed = line.trim()
  return (
    trimmed.length > 0 &&
    !trimmed.startsWith('//') &&
    !trimmed.startsWith('/*') &&
    !trimmed.startsWith('*') &&
    !trimmed.startsWith('*/')
  )
}

function countEffectiveLines(filePath) {
  const text = fs.readFileSync(filePath, 'utf8')
  if (text.length === 0) return 0
  const normalized = text.endsWith('\n') ? text.slice(0, -1) : text
  return normalized.length === 0
    ? 0
    : normalized.split(/\r?\n/).filter(isEffectiveSourceLine).length
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

function main() {
  const files = walk(compilerSrc)
  const rows = files
    .map(filePath => {
      const relative = toPosix(path.relative(process.cwd(), filePath))
      return {
        file: relative,
        loc: countEffectiveLines(filePath),
        budget: fileBudgets.get(relative) ?? defaultMaxLoc,
      }
    })
    .sort((a, b) => b.loc - a.loc)

  const totalLoc = rows.reduce((sum, row) => sum + row.loc, 0)
  const failures = []

  for (const row of rows) {
    if (row.loc > row.budget) {
      failures.push(`${row.file}: ${row.loc} effective LOC exceeds budget ${row.budget}`)
    }
  }

  if (totalLoc > totalMaxLoc) {
    failures.push(`compiler src total: ${totalLoc} effective LOC exceeds budget ${totalMaxLoc}`)
  }

  console.log(`Compiler source files: ${rows.length}`)
  console.log(`Compiler effective source LOC: ${totalLoc} / ${totalMaxLoc}`)
  console.log('Largest compiler files:')
  console.table(
    rows.slice(0, topLimit).map(row => ({
      file: row.file,
      effectiveLoc: row.loc,
      budget: row.budget,
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
