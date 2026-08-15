import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const scriptPath = path.join(repoRoot, 'scripts/compiler-complexity-report.mjs')

function writeBudget(root: string, maxLines = 5) {
  const directory = path.join(root, '.github')
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    path.join(directory, 'compiler-complexity-budget.json'),
    JSON.stringify({
      schemaVersion: 2,
      reservePolicy: {
        minimumTotalLines: 1,
        maximumTotalPercent: 100,
        minimumFileOverrideLines: 1,
        maximumFileOverridePercent: 100,
        totalRatchetReductionLines: 2,
        fileOverrideRatchetReductionLines: 2,
      },
      total: { reviewedLines: 4, maxLines },
      defaultFileMaxLines: 100,
      fileOverrides: {},
    }),
  )
}

describe('compiler complexity report', () => {
  it('excludes pure block-comment lines from effective LOC', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'fict-complexity-'))
    try {
      const sourceDir = path.join(tempRoot, 'packages/compiler/src')
      mkdirSync(sourceDir, { recursive: true })
      writeFileSync(
        path.join(sourceDir, 'sample.ts'),
        `
/*
plain block comment line
*/
const value = 1
const marker = "/* not a comment */"
const afterComment = /* ignored */ value + 1
/* leading block comment */ const sameLine = afterComment
// plain line comment
`,
      )
      writeBudget(tempRoot)

      const output = execFileSync(process.execPath, [scriptPath], {
        cwd: tempRoot,
        encoding: 'utf8',
        env: { ...process.env, COMPILER_COMPLEXITY_TOP: '1' },
      })

      expect(output).toContain('Compiler effective source LOC: 4 / 5 (1 reserve)')
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('rejects an exact snapshot total without maintenance reserve', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'fict-complexity-'))
    try {
      const sourceDir = path.join(tempRoot, 'packages/compiler/src')
      mkdirSync(sourceDir, { recursive: true })
      writeFileSync(path.join(sourceDir, 'sample.ts'), 'export const sample = 1\n')
      writeBudget(tempRoot, 4)

      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: tempRoot,
        encoding: 'utf8',
      })

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Compiler total reserve 0 lines is below policy minimum 1')
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })
})
