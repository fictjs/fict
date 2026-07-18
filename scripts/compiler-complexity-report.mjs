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
const defaultMaxLoc = Number(process.env.COMPILER_COMPLEXITY_MAX_LOC ?? 100)
const totalMaxLoc = Number(process.env.COMPILER_COMPLEXITY_TOTAL_LOC ?? 854)

const fileBudgets = new Map([
  ['packages/compiler/src/environment-policy.ts', 48],
  ['packages/compiler/src/module-metadata.ts', 253],
  ['packages/compiler/src/native-loader.ts', 194],
  ['packages/compiler/src/native-target.ts', 84],
  ['packages/compiler/src/types.ts', 201],
])

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
