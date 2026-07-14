#!/usr/bin/env node

import { existsSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

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
const allowlistPath = path.resolve(
  readArgument('allowlist', path.join(root, '.github', 'compiler-shadow-allowlist.json')),
)
const outputPath = path.resolve(
  readArgument(
    'output',
    process.env.FICT_COMPILER_SHADOW_REPORT ??
      path.join(root, '.fict-cache', 'compiler-shadow.json'),
  ),
)
if (!existsSync(nativePath)) throw new Error(`Native compiler does not exist: ${nativePath}`)
if (!existsSync(allowlistPath)) throw new Error(`Shadow allowlist does not exist: ${allowlistPath}`)

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const result = spawnSync(pnpm, ['-C', 'examples/real-apps', 'build'], {
  cwd: root,
  env: {
    ...process.env,
    FICT_COMPILER_BACKEND: 'shadow',
    FICT_COMPILER_NATIVE_PATH: nativePath,
    FICT_COMPILER_SHADOW_ALLOWLIST: allowlistPath,
    FICT_COMPILER_SHADOW_REPORT: outputPath,
    FICT_COMPILER_SHADOW_FAIL_ON_DIFFERENCE: '1',
  },
  stdio: 'inherit',
})
if (result.status !== 0)
  throw new Error(`Compiler shadow build failed (${result.status ?? 'signal'}).`)
if (!existsSync(outputPath)) throw new Error('Compiler shadow build did not produce its artifact')
process.stdout.write('[compiler-shadow-gate] Privacy-safe shadow artifact passed.\n')
