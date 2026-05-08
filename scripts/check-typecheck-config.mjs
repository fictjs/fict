#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const tscBin = require.resolve('typescript/bin/tsc')

const criticalPackages = ['compiler', 'devtools', 'eslint-plugin', 'ssr', 'vite-plugin']

const failures = []

function toPosix(value) {
  return value.split(path.sep).join('/')
}

function listPackageFiles(packageDir) {
  const tsconfig = path.join(packageDir, 'tsconfig.json')
  if (!existsSync(tsconfig)) {
    return null
  }

  const output = execFileSync(process.execPath, [tscBin, '-p', tsconfig, '--showConfig'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const config = JSON.parse(output)
  const configDir = path.dirname(tsconfig)

  return new Set(
    (config.files ?? []).map(file =>
      toPosix(path.relative(packageDir, path.resolve(configDir, file))),
    ),
  )
}

function hasDirectory(packageDir, name) {
  return (
    existsSync(path.join(packageDir, name)) && statSync(path.join(packageDir, name)).isDirectory()
  )
}

function hasSourceFile(files) {
  return [...files].some(file => file.startsWith('src/') && /\.(ts|tsx)$/.test(file))
}

function hasTestFile(files) {
  return [...files].some(
    file => /(^|\/)(__tests__|test|tests)\//.test(file) && /\.(ts|tsx)$/.test(file),
  )
}

for (const packageName of criticalPackages) {
  const packageDir = path.join(repoRoot, 'packages', packageName)
  const files = listPackageFiles(packageDir)

  if (!files) {
    failures.push(`${packageName}: missing tsconfig.json`)
    continue
  }

  if (hasDirectory(packageDir, 'src') && !hasSourceFile(files)) {
    failures.push(`${packageName}: tsc --showConfig does not include package src files`)
  }

  if (packageName === 'compiler' && !hasTestFile(files)) {
    failures.push(`${packageName}: tsc --showConfig does not include compiler test files`)
  }

  if (files.size === 1 && [...files][0] === '../runtime/src/dev.d.ts') {
    failures.push(`${packageName}: typecheck only includes runtime dev declarations`)
  }
}

if (failures.length > 0) {
  console.error('Typecheck configuration guard failed:')
  for (const failure of failures) {
    console.error(`- ${failure}`)
  }
  process.exit(1)
}

console.log(
  `Typecheck configuration guard passed for ${criticalPackages.length} critical packages.`,
)
