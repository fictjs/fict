#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const repoRoot = path.resolve(path.dirname(scriptPath), '..')
const pinnedToolchain = '+nightly-2026-04-28'

function runLockedCargo(
  args,
  { root = repoRoot, command = 'cargo', spawn = spawnSync, stdio = 'inherit' } = {},
) {
  const lockPath = path.join(root, 'fuzz', 'Cargo.lock')
  const before = readFileSync(lockPath)
  const result = spawn(command, [pinnedToolchain, ...args], {
    cwd: root,
    stdio,
  })
  const after = readFileSync(lockPath)

  if (!before.equals(after)) {
    writeFileSync(lockPath, before)
    throw new Error(
      'Cargo changed fuzz/Cargo.lock; the change was reverted. Refresh and commit the independent fuzz lock before running again.',
    )
  }
  if (result.error) throw result.error
  if (result.signal) throw new Error(`cargo-fuzz terminated by signal ${result.signal}.`)
  return result.status ?? 1
}

export function verifyFuzzLock(options = {}) {
  return runLockedCargo(
    ['metadata', '--manifest-path', 'fuzz/Cargo.toml', '--locked', '--format-version', '1'],
    { stdio: ['inherit', 'ignore', 'inherit'], ...options },
  )
}

export function runLockedFuzz(args, options = {}) {
  if (!Array.isArray(args) || args.length === 0) {
    throw new Error('Expected cargo-fuzz arguments.')
  }
  return runLockedCargo(['fuzz', ...args], options)
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    const args = process.argv.slice(2)
    process.exitCode =
      args.length === 1 && args[0] === '--verify-lock' ? verifyFuzzLock() : runLockedFuzz(args)
  } catch (error) {
    console.error(`[compiler-fuzz] ${error.stack ?? error.message ?? error}`)
    process.exitCode = 1
  }
}
