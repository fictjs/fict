import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'

import { executeDomCommonJs } from './lib/compiler-dom-semantic-harness.mjs'
import { materializeDomSemanticFixture } from './lib/compiler-dom-semantic-fixtures.mjs'

const require = createRequire(import.meta.url)
const repositoryRoot = path.resolve(import.meta.dirname, '..')
const read = relative => readFileSync(path.join(repositoryRoot, relative), 'utf8')
const inputsText = read('scripts/fixtures/babel_0_28_dom_semantic_inputs.json')
const inputs = JSON.parse(inputsText)
const corpusText = read('crates/fict-compiler/tests/rust_frozen_codegen_corpus.json')
const corpus = JSON.parse(corpusText)
const oracle = JSON.parse(read('crates/fict-compiler/tests/babel_0_28_dom_semantic_oracle.json'))
const binding = require(path.join(repositoryRoot, 'target/release/fict_compiler_napi.node'))
const sha256 = value => createHash('sha256').update(value).digest('hex')
const diagnosticSignature = diagnostics =>
  diagnostics.map(({ code, severity }) => `${code}:${severity}`).sort()
const expectedRequiredPropsCorpusFixtureIds = [
  'packages/compiler/test/codegen.test.ts:1286:transform',
  'packages/compiler/test/codegen.test.ts:1373:transform',
  'packages/compiler/test/codegen.test.ts:1415:transform',
  'packages/compiler/test/codegen.test.ts:1830:transform',
  'packages/compiler/test/explain-artifact.test.ts:12:transform',
  'packages/compiler/test/reactivity-torture.test.ts:191:transformWithCompilerDefaults',
  'packages/compiler/test/props-name-collision.test.ts:7:transform',
  'packages/compiler/test/props-name-collision.test.ts:56:transform',
  'packages/compiler/test/props-name-collision.test.ts:73:transform',
  'packages/compiler/test/spec-rules.test.ts:693:transform',
  'packages/compiler/test/spec-rules.test.ts:738:transformWithWarnings',
  'packages/compiler/test/spec-rules.test.ts:746:transformWithWarnings',
  'packages/compiler/test/spec-rules.test.ts:782:transform',
  'packages/compiler/test/spec-rules.test.ts:787:transformWithWarnings',
  'packages/compiler/test/spec-rules.test.ts:804:transformWithWarnings',
  'packages/compiler/test/spec-rules.test.ts:815:transformWithWarnings',
  'packages/compiler/test/spec-rules.test.ts:826:transformWithWarnings',
  'packages/compiler/test/spec-rules.test.ts:837:transformWithWarnings',
  'packages/compiler/test/spec-rules.test.ts:848:transformWithWarnings',
  'packages/compiler/test/spec-rules.test.ts:879:transformWithWarnings',
  'packages/compiler/test/spec-rules.test.ts:889:transformWithWarnings',
  'packages/compiler/test/svg-namespace.test.ts:206:transform',
  'packages/compiler/test/svg-namespace.test.ts:246:transform',
  'packages/compiler/test/svg-namespace.test.ts:401:transform',
  'packages/compiler/test/template-integration.test.ts:5494:compileAndLoad',
  'packages/compiler/test/warnings-as-errors.test.ts:487:transform',
]
const expectedRustDeviationIds = ['props-warnings-structured-hook-branch']

function textNodes(nodes) {
  return nodes.flatMap(node =>
    node.type === 'text' ? [node.value] : node.type === 'element' ? textNodes(node.children) : [],
  )
}

function treeShape(nodes) {
  return nodes.map(node =>
    node.type === 'text' ? { type: 'text' } : { ...node, children: treeShape(node.children) },
  )
}

function assertRustDomTrace(actual, expected, fixture) {
  if (fixture.rustDeviation === undefined) {
    assert.deepEqual(actual, expected, `${fixture.id} Rust output`)
    return
  }

  assert.deepEqual(Object.keys(fixture.rustDeviation).sort(), [
    'classification',
    'expectedText',
    'expectedTextNodes',
    'reason',
  ])
  assert.equal(fixture.rustDeviation.classification, 'intentional-legacy-bug-fix')
  assert.equal(typeof fixture.rustDeviation.reason, 'string')
  assert.ok(fixture.rustDeviation.reason.length > 0)
  assert.equal(actual.length, 1, `${fixture.id} Rust trace length`)
  assert.equal(expected.length, 1, `${fixture.id} Babel trace length`)
  assert.equal(actual[0].label, expected[0].label, `${fixture.id} trace label`)
  assert.deepEqual(
    actual[0].value.elements,
    expected[0].value.elements,
    `${fixture.id} element semantics`,
  )
  assert.deepEqual(
    treeShape(actual[0].value.tree),
    treeShape(expected[0].value.tree),
    `${fixture.id} DOM tree shape`,
  )
  assert.equal(actual[0].value.text, fixture.rustDeviation.expectedText, `${fixture.id} text`)
  assert.deepEqual(
    textNodes(actual[0].value.tree),
    fixture.rustDeviation.expectedTextNodes,
    `${fixture.id} text nodes`,
  )
  assert.notEqual(actual[0].value.text, expected[0].value.text, `${fixture.id} legacy deviation`)
}

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
    rustCodegenCorpusSha256: sha256(corpusText),
    sharedRuntimePackage: '@fictjs/runtime@0.31.0',
    runtimeExecutionModel: 'frozen-babel-and-live-rust-output-share-current-runtime',
  })
  assert.equal(inputs.fixtures.length, 27)
  assert.equal(oracle.fixtures.length, inputs.fixtures.length)
  assert.deepEqual(
    inputs.fixtures
      .filter(fixture => fixture.corpusFixtureId !== undefined)
      .map(fixture => fixture.corpusFixtureId),
    expectedRequiredPropsCorpusFixtureIds,
  )
  assert.deepEqual(
    inputs.fixtures
      .filter(fixture => fixture.rustDeviation !== undefined)
      .map(fixture => fixture.id),
    expectedRustDeviationIds,
  )
})

const oracleById = new Map(oracle.fixtures.map(fixture => [fixture.id, fixture]))
for (const fixtureInput of inputs.fixtures) {
  const fixture = materializeDomSemanticFixture(fixtureInput, corpus)
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
      diagnosticSignature(fixture.rustDiagnostics ?? expected.babelDiagnostics),
      `${fixture.id} diagnostics`,
    )
    assertRustDomTrace(
      await executeDomCommonJs(result.code, fixture.scenario),
      expected.expected,
      fixture,
    )
  })
}

test('Babel DOM semantic oracle contains no unreferenced or duplicate fixtures', () => {
  assert.equal(oracleById.size, oracle.fixtures.length)
  assert.deepEqual([...oracleById.keys()].sort(), inputs.fixtures.map(fixture => fixture.id).sort())
})
