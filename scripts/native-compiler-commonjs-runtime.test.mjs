import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const root = path.resolve(import.meta.dirname, '..')
const binding = require(path.join(root, 'target/release/fict_compiler_napi.node'))

function compileCommonJs(code, filename) {
  const result = binding.transformSync({
    code,
    filename,
    language: 'ts',
    moduleKind: 'commonjs',
    options: { strictGuarantee: false },
  })
  assert.deepEqual(
    result.diagnostics.filter(diagnostic => diagnostic.severity === 'error'),
    [],
    result.diagnostics.map(diagnostic => `${diagnostic.code}: ${diagnostic.message}`).join('\n'),
  )
  assert.notEqual(result.code, '')
  return result.code
}

test('executes CommonJS output with every Node wrapper binding shadowed by the source', () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'fict-commonjs-host-bindings-'))
  try {
    writeFileSync(
      path.join(fixtureRoot, 'dependency.cjs'),
      'module.exports = { value: 42 }\n',
      'utf8',
    )
    const entryPath = path.join(fixtureRoot, 'entry.cjs')
    writeFileSync(
      entryPath,
      compileCommonJs(
        `
          const require = 'user-require'
          const exports = 'user-exports'
          const module = 'user-module'
          const __filename = 'user-filename'
          const __dirname = 'user-dirname'
          const arguments = 'user-arguments'
          import dependency from './dependency.cjs'
          export const values = [
            require,
            exports,
            module,
            __filename,
            __dirname,
            arguments,
            dependency.value,
          ]
        `,
        entryPath,
      ),
      'utf8',
    )

    assert.deepEqual(require(entryPath).values, [
      'user-require',
      'user-exports',
      'user-module',
      'user-filename',
      'user-dirname',
      'user-arguments',
      42,
    ])
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true })
  }
})

test('re-exports only enumerable own properties from a raw CommonJS dependency', () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'fict-commonjs-export-star-'))
  try {
    writeFileSync(
      path.join(fixtureRoot, 'dependency.cjs'),
      `
        let current = 1
        const value = Object.create({ inherited: 'wrong' })
        Object.defineProperty(value, 'live', {
          enumerable: true,
          get() { return current },
        })
        value.own = 'right'
        value.update = next => { current = next }
        module.exports = value
      `,
      'utf8',
    )
    const entryPath = path.join(fixtureRoot, 'entry.cjs')
    writeFileSync(entryPath, compileCommonJs(`export * from './dependency.cjs'`, entryPath), 'utf8')

    const exported = require(entryPath)
    assert.deepEqual(Object.keys(exported).sort(), ['live', 'own', 'update'])
    assert.equal(Object.hasOwn(exported, 'inherited'), false)
    assert.equal(exported.inherited, undefined)
    assert.equal(exported.live, 1)
    exported.update(2)
    assert.equal(exported.live, 2)
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true })
  }
})
