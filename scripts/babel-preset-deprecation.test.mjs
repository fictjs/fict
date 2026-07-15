import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function run(nodeEnv) {
  return spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        import preset from './packages/babel-preset/dist/index.js'
        const api = { assertVersion() {} }
        preset(api)
        preset(api)
        await new Promise(resolve => setImmediate(resolve))
      `,
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: nodeEnv },
    },
  )
}

test('legacy Babel preset warns at most once in development', () => {
  const result = run('development')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr.match(/FICT_BABEL_PRESET_DEPRECATED/g)?.length, 1)
  assert.match(
    result.stderr,
    /@fictjs\/babel-preset@0\.30\.1 and @fictjs\/compiler\/legacy@0\.30\.1 are the final supported legacy releases/,
  )
  assert.match(result.stderr, /Fict 1\.0\.0 removes the preset and in-tree legacy compiler/)
  assert.match(result.stderr, /@fictjs\/vite-plugin \(Rust is the default\)/)
  assert.match(result.stderr, /@fictjs\/webpack-plugin/)
  assert.match(result.stderr, /direct transforms to @fictjs\/compiler/)
})

test('legacy Babel preset does not warn during production compilation', () => {
  const result = run('production')
  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(result.stderr, /FICT_BABEL_PRESET_DEPRECATED/)
})
