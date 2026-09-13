import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { compilerCacheContext, turboArguments } from './run-turbo.mjs'

const repositoryRoot = path.resolve(import.meta.dirname, '..')
const runner = fileURLToPath(new URL('./run-turbo.mjs', import.meta.url))
const packageManager = JSON.parse(
  readFileSync(path.join(repositoryRoot, 'package.json')),
).packageManager

test('real Turbo builds invalidate on Rust inputs and same-path addon replacement', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'fict-build-cache-'))
  try {
    const write = (relative, text) => {
      const filename = path.join(directory, relative)
      mkdirSync(path.dirname(filename), { recursive: true })
      writeFileSync(filename, text)
    }
    write(
      'package.json',
      JSON.stringify({ name: 'fict-cache-fixture', private: true, packageManager }),
    )
    write('pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n")
    write('pnpm-lock.yaml', "lockfileVersion: '9.0'\nimporters:\n  .: {}\n  packages/probe: {}\n")
    write('.gitignore', 'node_modules\n.turbo\ndist\nexecutions.txt\n*.node\n')
    write('turbo.json', readFileSync(path.join(repositoryRoot, 'turbo.json')))
    write('crates/fict-probe/src/lib.rs', 'first source')
    write(
      'packages/probe/package.json',
      JSON.stringify({ name: 'cache-probe', scripts: { build: 'node build.mjs' } }),
    )
    write(
      'packages/probe/build.mjs',
      `
      import {appendFileSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs'
      appendFileSync('../../executions.txt', 'run\\n')
      mkdirSync('dist', {recursive: true})
      writeFileSync('dist/result.txt', readFileSync(process.env.FICT_COMPILER_NATIVE_PATH, 'utf8')
        + ':' + readFileSync('../../crates/fict-probe/src/lib.rs', 'utf8'))
    `,
    )
    write('native compiler.node', 'first addon')
    execFileSync('git', ['init', '-q'], { cwd: directory })

    const run = (nativePath = 'native compiler.node') => {
      execFileSync(
        process.execPath,
        [runner, 'run', 'build', '--filter=cache-probe', '--cache=local:rw', '--no-daemon'],
        {
          cwd: directory,
          env: {
            ...process.env,
            FICT_COMPILER_NATIVE_PATH: nativePath,
            TURBO_TELEMETRY_DISABLED: '1',
            TURBO_FORCE: 'false',
            TURBO_CACHE_DIR: path.join(directory, '.turbo/cache'),
          },
          stdio: 'pipe',
        },
      )
      return readFileSync(path.join(directory, 'packages/probe/dist/result.txt'), 'utf8')
    }
    const executions = () =>
      readFileSync(path.join(directory, 'executions.txt'), 'utf8').trim().split('\n').length
    assert.equal(run(), 'first addon:first source')
    assert.equal(executions(), 1)
    assert.equal(run(), 'first addon:first source')
    assert.equal(executions(), 1, 'unchanged inputs must reuse the cache')

    write('crates/fict-probe/src/lib.rs', 'second source')
    assert.equal(run(), 'first addon:second source')
    assert.equal(executions(), 2, 'Rust source changes must invalidate application builds')

    write('native compiler.node', 'second addon')
    assert.equal(run(), 'second addon:second source')
    assert.equal(executions(), 3, 'same-path addon replacement must invalidate the cache')

    write('another native compiler.node', 'second addon')
    assert.equal(run('another native compiler.node'), 'second addon:second source')
    assert.equal(
      executions(),
      3,
      'identical addon bytes do not depend on the machine-specific path',
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a missing default addon disables caching without breaking non-native commands', () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'fict-cache-missing-'))
  try {
    const context = compilerCacheContext({ cwd, env: {} })
    assert.equal(context.force, true)
    assert.equal(context.env.FICT_COMPILER_NATIVE_PATH, undefined)
    assert.deepEqual(turboArguments(['run', 'lint', '--', '--fix'], context.force), [
      'run',
      'lint',
      '--force',
      '--',
      '--fix',
    ])
    assert.throws(
      () => compilerCacheContext({ cwd, env: { FICT_COMPILER_NATIVE_PATH: 'missing.node' } }),
      { code: 'ENOENT' },
    )
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
