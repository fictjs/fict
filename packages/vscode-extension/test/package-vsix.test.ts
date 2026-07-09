import { execFile } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const temporaryDirectories: string[] = []
const packageRoot = path.resolve(import.meta.dirname, '..')

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(directory => rm(directory, { recursive: true, force: true })),
  )
})

describe('VSIX packaging', () => {
  it('packages through a valid Marketplace manifest without renaming the workspace package', async () => {
    const outputDirectory = await mkdtemp(path.join(tmpdir(), 'fict-vsix-test-'))
    temporaryDirectories.push(outputDirectory)
    const outputPath = path.join(outputDirectory, 'fict.vsix')

    await execFileAsync(
      process.execPath,
      [path.join(packageRoot, 'scripts/package-vsix.mjs'), '--out', outputPath],
      { cwd: packageRoot },
    )

    const output = await stat(outputPath)
    expect(output.isFile()).toBe(true)
    expect(output.size).toBeGreaterThan(0)
  })
})
