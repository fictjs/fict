#!/usr/bin/env node

import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runtimeDir = path.join(rootDir, 'packages/runtime')
const runtimeDist = path.join(runtimeDir, 'dist')
const runtimePackageJson = JSON.parse(readFileSync(path.join(runtimeDir, 'package.json'), 'utf8'))

const requiredDistFiles = [
  'index.js',
  'index.cjs',
  'index.d.ts',
  'internal.js',
  'internal.cjs',
  'internal.d.ts',
  'internal-list.js',
  'internal-list.cjs',
  'internal-list.d.ts',
  'advanced.js',
  'advanced.cjs',
  'advanced.d.ts',
  'loader.js',
  'loader.cjs',
  'loader.d.ts',
  'jsx-runtime.js',
  'jsx-runtime.cjs',
  'jsx-runtime.d.ts',
  'jsx-dev-runtime.js',
  'jsx-dev-runtime.cjs',
  'jsx-dev-runtime.d.ts',
]

const forbiddenDistFiles = ['index.dev.js', 'index.dev.js.map']

const exportChecks = [
  ['.', ['render', 'createEffect']],
  ['./internal', ['insertBetween', 'hydrateComponent', '__fictRunWithSSRSession']],
  ['./internal/list', ['createKeyedList', 'toNodeArray']],
  ['./advanced', ['createRenderEffect', 'createContext']],
  ['./loader', ['installResumableLoader', 'waitForPendingHandlers']],
  ['./jsx-runtime', ['jsx', 'jsxs', 'Fragment']],
  ['./jsx-dev-runtime', ['jsxDEV', 'Fragment']],
]

function fail(message) {
  console.error(`[runtime-package-smoke] ${message}`)
  process.exitCode = 1
}

for (const file of requiredDistFiles) {
  const filePath = path.join(runtimeDist, file)
  if (!existsSync(filePath)) {
    fail(`Missing runtime build artifact: ${path.relative(rootDir, filePath)}`)
  }
}

for (const file of forbiddenDistFiles) {
  const filePath = path.join(runtimeDist, file)
  if (existsSync(filePath)) {
    fail(`Unexpected non-exported runtime artifact: ${path.relative(rootDir, filePath)}`)
  }
}

if (process.exitCode) {
  console.error('[runtime-package-smoke] Run `pnpm --filter @fictjs/runtime build` first.')
  process.exit()
}

for (const [subpath, names] of exportChecks) {
  const entry = runtimePackageJson.exports?.[subpath]
  if (!entry?.import || !entry?.require || !entry?.types) {
    fail(`Package export ${subpath} must define import, require, and types targets.`)
    continue
  }

  const importTarget = path.join(runtimeDir, entry.import)
  const requireTarget = path.join(runtimeDir, entry.require)
  const typesTarget = path.join(runtimeDir, entry.types)
  if (!existsSync(typesTarget)) {
    fail(`Types target for ${subpath} is missing: ${path.relative(rootDir, typesTarget)}`)
  }

  const esm = await import(pathToFileURL(importTarget).href)
  const cjs = require(requireTarget)
  for (const name of names) {
    if (!(name in esm)) {
      fail(`ESM export ${subpath}#${name} is missing.`)
    }
    if (!(name in cjs)) {
      fail(`CJS export ${subpath}#${name} is missing.`)
    }
  }
}

if (!process.exitCode) {
  console.log('[runtime-package-smoke] Runtime package exports are usable.')
}
