#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

export function compilerCacheContext({ cwd = process.cwd(), env = process.env } = {}) {
  const nativePath = path.resolve(
    cwd,
    env.FICT_COMPILER_NATIVE_PATH || 'target/release/fict_compiler_napi.node',
  )
  try {
    const digest = createHash('sha256').update(readFileSync(nativePath)).digest('hex')
    return {
      env: {
        ...env,
        FICT_COMPILER_NATIVE_PATH: nativePath,
        FICT_COMPILER_ARTIFACT_HASH: digest,
      },
      force: false,
    }
  } catch (error) {
    if (env.FICT_COMPILER_NATIVE_PATH || error.code !== 'ENOENT') throw error
    // Typechecking and cleaning are usable before a native build. Without a
    // selected addon, do not cache builds that might load a registry fallback.
    return { env: { ...env, FICT_COMPILER_ARTIFACT_HASH: 'unavailable' }, force: true }
  }
}

export function turboArguments(args, force) {
  if (!force || args[0] !== 'run') return args
  const separator = args.indexOf('--')
  const position = separator < 0 ? args.length : separator
  return [...args.slice(0, position), '--force', ...args.slice(position)]
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const context = compilerCacheContext()
  const require = createRequire(import.meta.url)
  const turboPackagePath = require.resolve('turbo/package.json')
  const turboBin = path.resolve(path.dirname(turboPackagePath), require(turboPackagePath).bin.turbo)
  const child = spawn(
    process.execPath,
    [turboBin, ...turboArguments(process.argv.slice(2), context.force)],
    {
      env: context.env,
      stdio: 'inherit',
    },
  )
  const interrupt = () => child.kill('SIGINT')
  const terminate = () => child.kill('SIGTERM')
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', terminate)
  child.once('error', error => {
    console.error(error.message)
    process.exitCode = 1
  })
  child.once('exit', (code, signal) => {
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', terminate)
    if (signal) process.kill(process.pid, signal)
    else process.exitCode = code ?? 1
  })
}
