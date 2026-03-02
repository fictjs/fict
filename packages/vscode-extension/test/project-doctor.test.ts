import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { formatDoctorReport, runProjectDoctor } from '../src/commands/projectDoctor'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async dir => {
      await fs.rm(dir, { recursive: true, force: true })
    }),
  )
})

async function createTempProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fict-doctor-'))
  tempDirs.push(dir)
  return dir
}

describe('project doctor', () => {
  it('reports passing checks for a configured project', async () => {
    const root = await createTempProject()
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify(
        {
          dependencies: {
            '@fictjs/devtools': '^0.1.0',
          },
          devDependencies: {
            '@fictjs/eslint-plugin': '^0.1.0',
          },
        },
        null,
        2,
      ),
    )
    await fs.writeFile(
      path.join(root, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            jsxImportSource: 'fict',
          },
        },
        null,
        2,
      ),
    )
    await fs.writeFile(
      path.join(root, 'vite.config.ts'),
      "import fict from '@fictjs/vite-plugin';\nexport default { plugins: [fict()] };\n",
    )

    const checks = await runProjectDoctor(root)
    expect(checks.every(check => check.status === 'pass')).toBe(true)

    const report = formatDoctorReport(checks)
    expect(report).toContain('[PASS]')
  })

  it('reports warnings when key integrations are missing', async () => {
    const root = await createTempProject()
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'demo' }, null, 2))

    const checks = await runProjectDoctor(root)

    expect(checks.some(check => check.status === 'warn')).toBe(true)
    expect(checks.some(check => check.id === 'devtools' && check.status === 'info')).toBe(true)
  })
})
