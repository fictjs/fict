import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { runLockedFuzz, verifyFuzzLock } from './run-locked-fuzz.mjs'

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'fict-fuzz-lock-'))
  const lockPath = path.join(root, 'fuzz', 'Cargo.lock')
  mkdirSync(path.dirname(lockPath), { recursive: true })
  writeFileSync(lockPath, 'locked\n')
  return { root, lockPath }
}

test('runs the pinned cargo-fuzz command without changing its independent lock', t => {
  const { root, lockPath } = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  let invocation

  const status = runLockedFuzz(['build', 'compiler_pipeline'], {
    root,
    spawn(command, args, options) {
      invocation = { command, args, options }
      return { error: undefined, signal: null, status: 0 }
    },
  })

  assert.equal(status, 0)
  assert.deepEqual(invocation, {
    command: 'cargo',
    args: ['+nightly-2026-04-28', 'fuzz', 'build', 'compiler_pipeline'],
    options: { cwd: root, stdio: 'inherit' },
  })
  assert.equal(readFileSync(lockPath, 'utf8'), 'locked\n')
})

test('verifies the complete pinned dependency graph without printing metadata', t => {
  const { root } = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  let invocation

  const status = verifyFuzzLock({
    root,
    spawn(command, args, options) {
      invocation = { command, args, options }
      return { error: undefined, signal: null, status: 0 }
    },
  })

  assert.equal(status, 0)
  assert.deepEqual(invocation, {
    command: 'cargo',
    args: [
      '+nightly-2026-04-28',
      'metadata',
      '--manifest-path',
      'fuzz/Cargo.toml',
      '--locked',
      '--format-version',
      '1',
    ],
    options: { cwd: root, stdio: ['inherit', 'ignore', 'inherit'] },
  })
})

test('fails closed when cargo-fuzz rewrites the independent lock', t => {
  const { root, lockPath } = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  assert.throws(
    () =>
      runLockedFuzz(['run', 'compiler_pipeline'], {
        root,
        spawn() {
          writeFileSync(lockPath, 'updated\n')
          return { error: undefined, signal: null, status: 0 }
        },
      }),
    /changed fuzz\/Cargo\.lock/,
  )
  assert.equal(readFileSync(lockPath, 'utf8'), 'locked\n')
})

test('preserves cargo-fuzz failures when the lock remains unchanged', t => {
  const { root } = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  assert.equal(
    runLockedFuzz(['build', 'compiler_pipeline'], {
      root,
      spawn: () => ({ error: undefined, signal: null, status: 7 }),
    }),
    7,
  )
})
