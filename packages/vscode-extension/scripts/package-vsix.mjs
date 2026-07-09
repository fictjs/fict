#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = resolve(packageRoot, '../..')
const manifest = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'))
const extensionName = manifest.config?.vscodeExtensionName

if (typeof extensionName !== 'string' || !/^[a-z0-9][a-z0-9-]*$/i.test(extensionName)) {
  throw new Error('package.json#config.vscodeExtensionName must be a valid unscoped extension name')
}

const stagingRoot = await mkdtemp(resolve(tmpdir(), 'fict-vscode-extension-'))

function normalizeOutputArgs(args) {
  const normalized = [...args]
  let hasOutput = false

  for (let index = 0; index < normalized.length; index++) {
    const argument = normalized[index]
    if (argument === '--out' || argument === '-o') {
      const output = normalized[index + 1]
      if (!output) throw new Error(`${argument} requires an output path`)
      normalized[index + 1] = isAbsolute(output) ? output : resolve(packageRoot, output)
      hasOutput = true
      index++
    } else if (argument?.startsWith('--out=')) {
      const output = argument.slice('--out='.length)
      if (!output) throw new Error('--out requires an output path')
      normalized[index] = `--out=${isAbsolute(output) ? output : resolve(packageRoot, output)}`
      hasOutput = true
    }
  }

  if (!hasOutput) {
    normalized.push('--out', resolve(packageRoot, `${extensionName}-${manifest.version}.vsix`))
  }

  return normalized
}

async function runVsce(args) {
  const cliPath = require.resolve('@vscode/vsce/vsce')
  await new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [cliPath, 'package', '--no-dependencies', ...normalizeOutputArgs(args)],
      {
        cwd: stagingRoot,
        stdio: 'inherit',
      },
    )
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise()
      } else {
        reject(new Error(`vsce exited with ${signal ? `signal ${signal}` : `code ${code}`}`))
      }
    })
  })
}

try {
  const extensionManifest = {
    ...manifest,
    name: extensionName,
    files: ['dist/extension.cjs', 'media', 'LICENSE', 'README.md', 'CHANGELOG.md'],
    scripts: { ...manifest.scripts },
  }
  delete extensionManifest.scripts['vscode:prepublish']

  await Promise.all([
    cp(resolve(packageRoot, 'dist'), resolve(stagingRoot, 'dist'), { recursive: true }),
    cp(resolve(packageRoot, 'media'), resolve(stagingRoot, 'media'), { recursive: true }),
    cp(resolve(packageRoot, 'README.md'), resolve(stagingRoot, 'README.md')),
    cp(resolve(packageRoot, 'CHANGELOG.md'), resolve(stagingRoot, 'CHANGELOG.md')),
    cp(resolve(repositoryRoot, 'LICENSE'), resolve(stagingRoot, 'LICENSE')),
  ])
  await writeFile(
    resolve(stagingRoot, 'package.json'),
    `${JSON.stringify(extensionManifest, null, 2)}\n`,
  )

  await runVsce(process.argv.slice(2))
} finally {
  await rm(stagingRoot, { recursive: true, force: true })
}
