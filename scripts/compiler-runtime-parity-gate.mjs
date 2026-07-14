#!/usr/bin/env node

import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

function readArgument(name, fallback) {
  const prefix = `--${name}=`
  const inline = process.argv.find(argument => argument.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const nativePath = path.resolve(
  readArgument('native-path', path.join(root, 'target', 'release', 'fict_compiler_napi.node')),
)
const outputPath = path.resolve(
  readArgument(
    'output',
    process.env.FICT_RUNTIME_PARITY_OUTPUT ??
      path.join(root, '.fict-cache', 'compiler-runtime-parity.json'),
  ),
)

if (!existsSync(nativePath)) throw new Error(`Native compiler does not exist: ${nativePath}`)

const result = spawnSync(
  process.execPath,
  ['--test', path.join(root, 'scripts', 'native-compiler-runtime.test.mjs')],
  {
    cwd: root,
    env: { ...process.env, FICT_COMPILER_NATIVE_PATH: nativePath },
    stdio: 'inherit',
  },
)
if (result.status !== 0) {
  throw new Error(`Native compiler runtime parity suite failed (${result.status ?? 'signal'}).`)
}

const binding = require(nativePath)
const info = binding.nativeCompilerInfo()
const artifact = {
  schemaVersion: 1,
  compilerBuildId: info.compilerBuildId,
  status: 'pass',
  contracts: {
    coreRuntimeParity: true,
    strictGuaranteeMatrix: true,
    nativeRuntimeRegressionSuite: true,
  },
}
await mkdir(path.dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
process.stdout.write(
  `[compiler-runtime-parity] Wrote passing evidence for ${info.compilerBuildId}.\n`,
)
