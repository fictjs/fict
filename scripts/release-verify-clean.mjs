#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const repoRoot = path.resolve(path.dirname(scriptPath), '..')
const packageManager = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

function run(command, args, options = {}) {
  console.log(`[release-verify-clean] $ ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: options.capture ? 'utf8' : undefined,
    env: { ...process.env, ...options.env },
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const output = options.capture
      ? [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
      : ''
    throw new Error(`${command} exited with status ${result.status}${output ? `:\n${output}` : ''}`)
  }
  return options.capture ? result.stdout.trim() : ''
}

export function dirtyCheckoutMessage(status) {
  const paths = status
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(0, 10)
    .map(line => `  ${line}`)
  if (paths.length === 0) return null
  return `Refusing to verify an uncommitted checkout:\n${paths.join('\n')}`
}

export function pnpmStoreRoot(activeStorePath) {
  const normalized = path.resolve(activeStorePath)
  return /^v\d+$/.test(path.basename(normalized)) ? path.dirname(normalized) : normalized
}

const localNoProxyHosts = ['localhost', '127.0.0.1', '::1']

export function releaseIsolationEnv(checkoutDir, sharedStoreDir, environment = process.env) {
  const noProxy = [environment.NO_PROXY, environment.no_proxy, ...localNoProxyHosts]
    .flatMap(value => value?.split(',') ?? [])
    .map(value => value.trim())
    .filter((value, index, values) => value && values.indexOf(value) === index)
    .join(',')

  return {
    CI: 'true',
    FICT_PNPM_STORE_DIR: sharedStoreDir,
    HUSKY: '0',
    NO_PROXY: noProxy,
    TURBO_CACHE_DIR: path.join(checkoutDir, '.turbo', 'release-cache'),
    no_proxy: noProxy,
  }
}

export function worktreeRemovalFailure(status, checkoutDir) {
  return status === 0
    ? null
    : `[release-verify-clean] Failed to remove temporary worktree ${checkoutDir}`
}

function main() {
  const status = run('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    capture: true,
  })
  const dirtyMessage = dirtyCheckoutMessage(status)
  if (dirtyMessage) throw new Error(dirtyMessage)

  const revision = run('git', ['rev-parse', '--verify', 'HEAD'], { capture: true })
  const sharedStoreDir = pnpmStoreRoot(run(packageManager, ['store', 'path'], { capture: true }))
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'fict-release-checkout-'))
  const checkoutDir = path.join(tempRoot, 'repo')
  let worktreeAdded = false

  try {
    run('git', ['worktree', 'add', '--detach', checkoutDir, revision])
    worktreeAdded = true
    run(packageManager, ['install', '--frozen-lockfile', '--store-dir', sharedStoreDir], {
      cwd: checkoutDir,
      env: { HUSKY: '0' },
    })
    run(packageManager, ['release:verify'], {
      cwd: checkoutDir,
      env: releaseIsolationEnv(checkoutDir, sharedStoreDir),
    })
    console.log(`[release-verify-clean] ${revision} passed from an isolated clean checkout.`)
  } finally {
    if (worktreeAdded) {
      const removal = spawnSync('git', ['worktree', 'remove', '--force', checkoutDir], {
        cwd: repoRoot,
        stdio: 'inherit',
      })
      if (removal.error) console.error(removal.error)
      const cleanupFailure = worktreeRemovalFailure(removal.status, checkoutDir)
      if (cleanupFailure) {
        console.error(cleanupFailure)
        process.exitCode = 1
      }
    }
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    main()
  } catch (error) {
    console.error(`[release-verify-clean] ${error.stack ?? error.message ?? error}`)
    process.exitCode = 1
  }
}
