import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

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

test('creates stable own-property namespaces for a raw CommonJS dependency', () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'fict-commonjs-namespace-'))
  try {
    writeFileSync(
      path.join(fixtureRoot, 'dependency.cjs'),
      `
        let current = 3
        const value = Object.create({ inherited: 'wrong' })
        value.named = 'named-value'
        Object.defineProperty(value, 'accessor', {
          enumerable: true,
          get() { return current },
        })
        Object.defineProperty(value, 'hidden', {
          enumerable: false,
          value: 'hidden-value',
        })
        value.update = next => { current = next }
        module.exports = value
      `,
      'utf8',
    )
    const entryPath = path.join(fixtureRoot, 'entry.cjs')
    writeFileSync(
      entryPath,
      compileCommonJs(
        `
          import defaultValue from './dependency.cjs'
          import * as first from './dependency.cjs'
          import * as second from './dependency.cjs'
          const Object = 'user-object'
          const WeakMap = 'user-weak-map'
          export function inspect() {
            const descriptor = globalThis.Object.getOwnPropertyDescriptor(first, 'accessor')
            return {
              accessor: first.accessor,
              accessorDescriptor: {
                enumerable: descriptor.enumerable,
                hasGetter: typeof descriptor.get === 'function',
              },
              defaultIdentity: first.default === defaultValue,
              inherited: first.inherited,
              inheritedOwn: globalThis.Object.hasOwn(first, 'inherited'),
              keys: globalThis.Object.keys(first).sort(),
              namedDescriptor: globalThis.Object.getOwnPropertyDescriptor(first, 'named'),
              namedOwn: globalThis.Object.hasOwn(first, 'named'),
              namespaceIdentity: first === second,
              spread: { ...first },
              userGlobals: [Object, WeakMap],
            }
          }
          export function update(next) { first.update(next) }
        `,
        entryPath,
      ),
      'utf8',
    )

    const exported = require(entryPath)
    const before = exported.inspect()
    assert.equal(before.namespaceIdentity, true)
    assert.deepEqual(before.userGlobals, ['user-object', 'user-weak-map'])
    assert.equal(before.defaultIdentity, true)
    assert.equal(before.namedOwn, true)
    assert.equal(before.inheritedOwn, false)
    assert.equal(before.inherited, undefined)
    assert.deepEqual(before.keys, ['accessor', 'default', 'named', 'update'])
    assert.deepEqual(before.accessorDescriptor, { enumerable: true, hasGetter: true })
    assert.deepEqual(
      {
        configurable: before.namedDescriptor.configurable,
        enumerable: before.namedDescriptor.enumerable,
        value: before.namedDescriptor.value,
        writable: before.namedDescriptor.writable,
      },
      { configurable: true, enumerable: true, value: 'named-value', writable: true },
    )
    assert.equal(before.spread.named, 'named-value')
    assert.equal(before.spread.default.named, 'named-value')
    assert.equal(Object.hasOwn(before.spread, 'hidden'), false)
    assert.equal(before.accessor, 3)
    exported.update(7)
    assert.equal(exported.inspect().accessor, 7)
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true })
  }
})

test('preserves default and namespace bindings from one CommonJS import', () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'fict-commonjs-mixed-import-'))
  try {
    writeFileSync(
      path.join(fixtureRoot, 'dependency.cjs'),
      `
        module.exports = function primary() {
          'use strict'
          return this === undefined
        }
        module.exports.named = 7
      `,
      'utf8',
    )
    const entryPath = path.join(fixtureRoot, 'entry.cjs')
    writeFileSync(
      entryPath,
      compileCommonJs(
        `
          import primary, * as namespace from './dependency.cjs'
          export const values = [
            primary === namespace.default,
            primary(),
            namespace.named,
          ]
        `,
        entryPath,
      ),
      'utf8',
    )

    assert.deepEqual(require(entryPath).values, [true, true, 7])
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true })
  }
})

test('lowers CommonJS import.meta.url to the executing file URL', () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'fict-commonjs-import-meta-'))
  try {
    const entryPath = path.join(fixtureRoot, 'entry.cjs')
    writeFileSync(
      entryPath,
      compileCommonJs(
        `
          export const moduleUrl = import.meta.url
        `,
        entryPath,
      ),
      'utf8',
    )

    const exported = require(entryPath)
    assert.equal(exported.moduleUrl, pathToFileURL(require.resolve(entryPath)).href)
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true })
  }
})

test('preserves local export precedence around CommonJS star re-exports', () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'fict-commonjs-precedence-'))
  try {
    writeFileSync(
      path.join(fixtureRoot, 'dependency.cjs'),
      `exports.collision = 'dependency'; exports.extra = 'extra'\n`,
      'utf8',
    )
    for (const [name, source, expected] of [
      [
        'local-before-star',
        `export const collision = 'before'; export * from './dependency.cjs'`,
        'before',
      ],
      [
        'local-after-star',
        `export * from './dependency.cjs'; export const collision = 'after'`,
        'after',
      ],
    ]) {
      const entryPath = path.join(fixtureRoot, `${name}.cjs`)
      writeFileSync(entryPath, compileCommonJs(source, entryPath), 'utf8')
      const exported = require(entryPath)
      assert.equal(exported.collision, expected)
      assert.equal(exported.extra, 'extra')
    }
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true })
  }
})

test('preserves live exports through a circular compiled CommonJS graph', () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'fict-commonjs-cycle-'))
  try {
    const aPath = path.join(fixtureRoot, 'a.cjs')
    const bPath = path.join(fixtureRoot, 'b.cjs')
    writeFileSync(
      aPath,
      compileCommonJs(
        `
          import { readB } from './b.cjs'
          export let valueA = 'a0'
          export function setA(next) { valueA = next }
          export function readCycle() { return readB() }
        `,
        aPath,
      ),
      'utf8',
    )
    writeFileSync(
      bPath,
      compileCommonJs(
        `
          import { valueA } from './a.cjs'
          export let valueB = 'b0'
          export function setB(next) { valueB = next }
          export function readB() { return [valueA, valueB] }
        `,
        bPath,
      ),
      'utf8',
    )

    const a = require(aPath)
    const b = require(bPath)
    assert.deepEqual(a.readCycle(), ['a0', 'b0'])
    a.setA('a1')
    b.setB('b1')
    assert.deepEqual(a.readCycle(), ['a1', 'b1'])
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true })
  }
})

test('preserves dynamic import semantics from compiled CommonJS output', async () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'fict-commonjs-dynamic-import-'))
  try {
    writeFileSync(path.join(fixtureRoot, 'dynamic.cjs'), `exports.value = 9\n`, 'utf8')
    const entryPath = path.join(fixtureRoot, 'entry.cjs')
    writeFileSync(
      entryPath,
      compileCommonJs(
        `
          export async function load() {
            const namespace = await import('./dynamic.cjs')
            return [namespace.value, namespace.default.value]
          }
        `,
        entryPath,
      ),
      'utf8',
    )

    assert.deepEqual(await require(entryPath).load(), [9, 9])
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true })
  }
})
