import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import { expect, it } from 'vitest'

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

it('keeps the root and core declarations usable without the optional Vite peer', () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'fict-devtools-types-'))

  try {
    const installedPackage = path.join(tempDir, 'node_modules/@fictjs/devtools')
    mkdirSync(installedPackage, { recursive: true })
    cpSync(path.join(packageDir, 'dist'), path.join(installedPackage, 'dist'), {
      recursive: true,
    })
    cpSync(path.join(packageDir, 'package.json'), path.join(installedPackage, 'package.json'))

    const packageJson = JSON.parse(
      readFileSync(path.join(installedPackage, 'package.json'), 'utf8'),
    ) as { peerDependenciesMeta?: { vite?: { optional?: boolean } } }
    expect(packageJson.peerDependenciesMeta?.vite?.optional).toBe(true)

    writeFileSync(
      path.join(tempDir, 'consumer.ts'),
      [
        "import { serialize } from '@fictjs/devtools'",
        "import { deserialize } from '@fictjs/devtools/core'",
        '',
        'serialize({ ready: true })',
        "deserialize('null')",
      ].join('\n'),
    )
    writeFileSync(
      path.join(tempDir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          lib: ['ES2020', 'DOM'],
          module: 'ESNext',
          moduleResolution: 'Bundler',
          noEmit: true,
          skipLibCheck: false,
          strict: true,
          target: 'ES2020',
          types: [],
        },
        files: ['consumer.ts'],
      }),
    )

    const result = spawnSync(
      process.execPath,
      [require.resolve('typescript/bin/tsc'), '--project', path.join(tempDir, 'tsconfig.json')],
      { cwd: tempDir, encoding: 'utf8' },
    )

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
})
