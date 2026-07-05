import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const scriptPath = path.join(repoRoot, 'scripts/compiler-complexity-report.mjs')

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

      const output = execFileSync(process.execPath, [scriptPath], {
        cwd: tempRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          COMPILER_COMPLEXITY_MAX_LOC: '100',
          COMPILER_COMPLEXITY_TOTAL_LOC: '100',
          COMPILER_COMPLEXITY_TOP: '1',
        },
      })

      expect(output).toContain('Compiler effective source LOC: 4 / 100')
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })
})
