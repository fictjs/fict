import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'

import { executeCommonJsAsync } from './lib/compiler-semantic-harness.mjs'

const require = createRequire(import.meta.url)
const repositoryRoot = path.resolve(import.meta.dirname, '..')
const read = relative => readFileSync(path.join(repositoryRoot, relative), 'utf8')
const inputsText = read('scripts/fixtures/babel_0_28_semantic_inputs.json')
const inputs = JSON.parse(inputsText)
const oracle = JSON.parse(read('crates/fict-compiler/tests/babel_0_28_semantic_oracle.json'))
const binding = require(path.join(repositoryRoot, 'target/release/fict_compiler_napi.node'))
const sha256 = value => createHash('sha256').update(value).digest('hex')
const diagnosticSignature = diagnostics =>
  diagnostics.map(({ code, severity }) => `${code}:${severity}`).sort()

test('Babel 0.28 semantic oracle has exact independent provenance', () => {
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
  })
  assert.equal(inputs.fixtures.length, 25)
  assert.equal(oracle.fixtures.length, inputs.fixtures.length)
})

const oracleById = new Map(oracle.fixtures.map(fixture => [fixture.id, fixture]))
for (const fixture of inputs.fixtures) {
  test(`Rust matches Babel 0.28 observable semantics: ${fixture.id}`, async () => {
    const expected = oracleById.get(fixture.id)
    assert.ok(expected, `missing Babel oracle ${fixture.id}`)
    assert.equal(sha256(expected.babelCode), expected.babelCodeSha256)
    assert.deepEqual(
      await executeCommonJsAsync(expected.babelCode, fixture.invocation),
      expected.expected,
      `${fixture.id} frozen Babel output`,
    )
    assert.ok(
      expected.babelDiagnostics.every(
        diagnostic =>
          /^FICT-[A-Z0-9-]+$/.test(diagnostic.code) &&
          ['error', 'warning', 'info'].includes(diagnostic.severity),
      ),
      `${fixture.id} Babel diagnostics`,
    )

    const result = binding.transformSync(fixture.request)
    assert.equal(
      result.diagnostics.some(diagnostic => diagnostic.severity === 'error'),
      false,
      `${fixture.id}: ${JSON.stringify(result.diagnostics)}`,
    )
    const babelDiagnostics = diagnosticSignature(expected.babelDiagnostics)
    const rustDiagnostics = diagnosticSignature(result.diagnostics)
    if (fixture.diagnosticDeviation === undefined) {
      assert.deepEqual(rustDiagnostics, babelDiagnostics, `${fixture.id} diagnostics`)
    } else if (fixture.diagnosticDeviation === 'rust-removes-spurious-hook-member-escape-warning') {
      assert.deepEqual(babelDiagnostics, ['FICT-R005:warning', 'FICT-R005:warning'], fixture.id)
      assert.deepEqual(rustDiagnostics, [], fixture.id)
    } else if (fixture.diagnosticDeviation === 'rust-adds-derived-projection-mutation-warning') {
      assert.equal(
        fixture.diagnosticDeviation,
        'rust-adds-derived-projection-mutation-warning',
        fixture.id,
      )
      assert.deepEqual(babelDiagnostics, ['FICT-R002:warning'], fixture.id)
      assert.deepEqual(rustDiagnostics, ['FICT-M:warning', 'FICT-R002:warning'], fixture.id)
    } else {
      assert.equal(
        fixture.diagnosticDeviation,
        'rust-adds-unproven-reactive-receiver-warning',
        fixture.id,
      )
      assert.deepEqual(babelDiagnostics, ['FICT-S002:warning', 'FICT-S002:warning'], fixture.id)
      assert.deepEqual(
        rustDiagnostics,
        ['FICT-M:warning', 'FICT-S002:warning', 'FICT-S002:warning'],
        fixture.id,
      )
    }
    assert.deepEqual(
      await executeCommonJsAsync(result.code, fixture.invocation),
      expected.expected,
      `${fixture.id} Rust output`,
    )
  })
}

test('Babel semantic oracle contains no unreferenced or duplicate fixtures', () => {
  assert.equal(oracleById.size, oracle.fixtures.length)
  assert.deepEqual([...oracleById.keys()].sort(), inputs.fixtures.map(fixture => fixture.id).sort())
  assert.deepEqual(
    inputs.fixtures
      .filter(fixture => fixture.diagnosticDeviation !== undefined)
      .map(fixture => [fixture.id, fixture.diagnosticDeviation]),
    [
      ['structured-hook-return', 'rust-removes-spurious-hook-member-escape-warning'],
      ['optional-nullish-dependency', 'rust-adds-derived-projection-mutation-warning'],
      ['vnode-event-order', 'rust-adds-unproven-reactive-receiver-warning'],
    ],
  )
})
