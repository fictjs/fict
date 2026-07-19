import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'

import { executeDomCommonJs } from './lib/compiler-dom-semantic-harness.mjs'

const require = createRequire(import.meta.url)
const repositoryRoot = path.resolve(import.meta.dirname, '..')
const read = relative => readFileSync(path.join(repositoryRoot, relative), 'utf8')
const inputsText = read('scripts/fixtures/babel_0_28_dom_semantic_inputs.json')
const inputs = JSON.parse(inputsText)
const oracle = JSON.parse(read('crates/fict-compiler/tests/babel_0_28_dom_semantic_oracle.json'))
const binding = require(path.join(repositoryRoot, 'target/release/fict_compiler_napi.node'))
const sha256 = value => createHash('sha256').update(value).digest('hex')
const diagnosticSignature = diagnostics =>
  diagnostics.map(({ code, severity }) => `${code}:${severity}`).sort()

test('Babel 0.28 DOM semantic oracle has exact independent provenance', () => {
  assert.equal(inputs.schemaVersion, 1)
  assert.equal(oracle.schemaVersion, 1)
  assert.deepEqual(oracle.provenance, {
    legacyRelease: '0.28.0',
    legacyRevision: 'b99ff5b185e3eed701e2d4f3521832dac67c979f',
    legacyCompilerSourceSha256: 'cbbaf8e6c3697e62bb5889cfebd472bada4063749140445c5098605866fd463a',
    legacyCompilerArtifactSha256:
      '07c4f89c35419434b1a6762e05b08340a0c080f8ff7dd09005cb782ed9621789',
    legacyLockfileSha256: '2b385eb419b90cf4f512a80ae925c2e2899bdb0e8d8c202cba8e09a9343b5af6',
    legacyPackageManager: 'pnpm@9.1.1',
    babelDependencies: {
      '@babel/core': '7.29.7',
      '@babel/plugin-transform-modules-commonjs': '7.28.6',
      '@babel/plugin-transform-typescript': '7.28.5',
    },
    oracleInputsSha256: sha256(inputsText),
    sharedRuntimePackage: '@fictjs/runtime@0.31.0',
    runtimeExecutionModel: 'frozen-babel-and-live-rust-output-share-current-runtime',
  })
  assert.equal(inputs.fixtures.length, 1)
  assert.equal(oracle.fixtures.length, inputs.fixtures.length)
})

const oracleById = new Map(oracle.fixtures.map(fixture => [fixture.id, fixture]))
for (const fixture of inputs.fixtures) {
  test(`Rust matches Babel 0.28 DOM interactions: ${fixture.id}`, async () => {
    const expected = oracleById.get(fixture.id)
    assert.ok(expected, `missing Babel DOM oracle ${fixture.id}`)
    assert.equal(sha256(expected.babelCode), expected.babelCodeSha256)
    assert.deepEqual(
      await executeDomCommonJs(expected.babelCode, fixture.scenario),
      expected.expected,
      `${fixture.id} frozen Babel output`,
    )

    const result = binding.transformSync(fixture.request)
    assert.equal(
      result.diagnostics.some(diagnostic => diagnostic.severity === 'error'),
      false,
      `${fixture.id}: ${JSON.stringify(result.diagnostics)}`,
    )
    assert.deepEqual(
      diagnosticSignature(result.diagnostics),
      diagnosticSignature(expected.babelDiagnostics),
      `${fixture.id} diagnostics`,
    )
    assert.deepEqual(
      await executeDomCommonJs(result.code, fixture.scenario),
      expected.expected,
      `${fixture.id} Rust output`,
    )
  })
}

test('Babel DOM semantic oracle contains no unreferenced or duplicate fixtures', () => {
  assert.equal(oracleById.size, oracle.fixtures.length)
  assert.deepEqual([...oracleById.keys()].sort(), inputs.fixtures.map(fixture => fixture.id).sort())
})
