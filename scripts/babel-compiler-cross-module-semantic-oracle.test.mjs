import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'

import {
  crossModuleBundlerProvenance,
  executeBundledCommonJsGraph,
} from './lib/compiler-cross-module-bundler-harness.mjs'
import { compileRustCrossModuleSemanticFixture } from './lib/compiler-cross-module-semantic-fixtures.mjs'
import { executeCommonJsGraph } from './lib/compiler-semantic-harness.mjs'

const require = createRequire(import.meta.url)
const repositoryRoot = path.resolve(import.meta.dirname, '..')
const read = relative => readFileSync(path.join(repositoryRoot, relative), 'utf8')
const inputsText = read('scripts/fixtures/babel_0_28_cross_module_semantic_inputs.json')
const inputs = JSON.parse(inputsText)
const semanticHarnessText = read('scripts/lib/compiler-semantic-harness.mjs')
const bundlerHarnessText = read('scripts/lib/compiler-cross-module-bundler-harness.mjs')
const oracle = JSON.parse(
  read('crates/fict-compiler/tests/babel_0_28_cross_module_semantic_oracle.json'),
)
const binding = require(path.join(repositoryRoot, 'target/release/fict_compiler_napi.node'))
const sha256 = value => createHash('sha256').update(value).digest('hex')
const expectedFixtureIds = [
  'hook-return-shapes',
  'reactive-exports-through-barrel',
  'namespace-hook-reexport',
  'hook-call-wrapper-chain',
  'special-hook-export-names',
  'type-only-barrel',
  'reactive-namespace-import',
]

test('Babel 0.28 cross-module semantic oracle has exact independent provenance', () => {
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
    semanticHarnessSha256: sha256(semanticHarnessText),
    bundlerHarnessSha256: sha256(bundlerHarnessText),
    runtimeExecutionModel: 'frozen-babel-and-live-rust-graphs-share-synthetic-runtime',
    ...crossModuleBundlerProvenance(),
  })
  assert.deepEqual(
    inputs.fixtures.map(fixture => fixture.id),
    expectedFixtureIds,
  )
  assert.equal(oracle.fixtures.length, expectedFixtureIds.length)
  assert.equal(
    inputs.fixtures.reduce((count, fixture) => count + fixture.modules.length, 0),
    18,
  )
})

const oracleById = new Map(oracle.fixtures.map(fixture => [fixture.id, fixture]))
for (const fixture of inputs.fixtures) {
  test(`Rust matches Babel 0.28 cross-module semantics: ${fixture.id}`, async () => {
    const expected = oracleById.get(fixture.id)
    assert.ok(expected, `missing Babel cross-module oracle ${fixture.id}`)
    assert.equal(expected.entryId, fixture.entryId, fixture.id)
    assert.deepEqual(expected.invocation, fixture.invocation, fixture.id)
    assert.deepEqual(
      expected.modules.map(module => ({ id: module.id, dependencies: module.dependencies })),
      fixture.modules.map(module => ({ id: module.id, dependencies: module.dependencies })),
      fixture.id,
    )

    for (const module of expected.modules) {
      assert.equal(sha256(module.babelCode), module.babelCodeSha256, module.id)
      assert.ok(
        module.babelDiagnostics.every(
          diagnostic =>
            /^FICT-[A-Z0-9-]+$/.test(diagnostic.code) &&
            ['error', 'warning', 'info'].includes(diagnostic.severity),
        ),
        `${module.id}: Babel diagnostics`,
      )
    }
    assert.deepEqual(
      executeCommonJsGraph(
        expected.modules.map(module => ({
          id: module.id,
          dependencies: module.dependencies,
          code: module.babelCode,
        })),
        expected.entryId,
        expected.invocation,
      ),
      expected.expected,
      `${fixture.id} frozen Babel graph`,
    )
    assert.deepEqual(
      await executeBundledCommonJsGraph(
        expected.modules.map(module => ({
          id: module.id,
          dependencies: module.dependencies,
          code: module.babelCode,
        })),
        expected.entryId,
        expected.invocation,
      ),
      expected.bundledExpected,
      `${fixture.id} frozen Babel graph through Webpack and the real runtime`,
    )
    assert.deepEqual(
      expected.bundledExpected,
      expected.expected,
      `${fixture.id} real and synthetic runtime observations`,
    )

    const compiled = compileRustCrossModuleSemanticFixture(binding, fixture)
    assert.equal(compiled.modules.length, expected.modules.length, fixture.id)
    for (const [index, module] of compiled.modules.entries()) {
      assert.equal(
        module.result.diagnostics.some(diagnostic => diagnostic.severity === 'error'),
        false,
        `${module.id}: ${JSON.stringify(module.result.diagnostics)}`,
      )
      assert.deepEqual(
        module.result.moduleMetadata,
        expected.modules[index].babelMetadata,
        `${module.id}: metadata`,
      )
    }
    assert.deepEqual(
      executeCommonJsGraph(compiled.modules, compiled.entryId, compiled.invocation),
      expected.expected,
      `${fixture.id} Rust graph`,
    )
    assert.deepEqual(
      await executeBundledCommonJsGraph(compiled.modules, compiled.entryId, compiled.invocation),
      expected.bundledExpected,
      `${fixture.id} Rust graph through Webpack and the real runtime`,
    )
  })
}

test('Babel cross-module oracle contains no unreferenced or duplicate fixtures', () => {
  assert.equal(oracleById.size, oracle.fixtures.length)
  assert.deepEqual([...oracleById.keys()], expectedFixtureIds)
  assert.deepEqual(
    oracle.fixtures.map(fixture => fixture.id),
    inputs.fixtures.map(fixture => fixture.id),
  )
})
