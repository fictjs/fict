import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'

import {
  assertProbeMapping,
  traceGeneratedPosition,
  validateSourceMapFixture,
} from './lib/compiler-source-map-semantic-harness.mjs'

const require = createRequire(import.meta.url)
const repositoryRoot = path.resolve(import.meta.dirname, '..')
const read = relative => readFileSync(path.join(repositoryRoot, relative), 'utf8')
const inputsText = read('scripts/fixtures/babel_0_28_source_map_inputs.json')
const inputs = JSON.parse(inputsText)
const harnessText = read('scripts/lib/compiler-source-map-semantic-harness.mjs')
const oracle = JSON.parse(read('crates/fict-compiler/tests/babel_0_28_source_map_oracle.json'))
const binding = require(path.join(repositoryRoot, 'target/release/fict_compiler_napi.node'))
const sha256 = value => createHash('sha256').update(value).digest('hex')
const expectedFixtureIds = [
  'reactive-jsx-control-flow',
  'unicode-effects-and-async-handler',
  'commonjs-typescript-rewrite',
]

test('Babel 0.28 source-map oracle has exact independent provenance', () => {
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
    traceMappingDependency: '@jridgewell/trace-mapping@0.3.31',
    oracleInputsSha256: sha256(inputsText),
    sourceMapHarnessSha256: sha256(harnessText),
    comparisonModel: 'frozen-babel-generated-tokens-vs-live-rust-authored-original-positions',
  })
  assert.equal(require('@jridgewell/trace-mapping/package.json').version, '0.3.31')
  assert.deepEqual(
    inputs.fixtures.map(fixture => fixture.id),
    expectedFixtureIds,
  )
  assert.equal(oracle.fixtures.length, expectedFixtureIds.length)

  const probes = inputs.fixtures.flatMap(fixture => fixture.probes)
  assert.equal(probes.length, 23)
  assert.equal(probes.filter(probe => probe.disposition === 'exact-parity').length, 10)
  assert.equal(
    probes.filter(probe => probe.disposition === 'rust-precision-improvement').length,
    13,
  )
  assert.equal(new Set(probes.map(probe => probe.id)).size, probes.length)
})

const oracleById = new Map(oracle.fixtures.map(fixture => [fixture.id, fixture]))
for (const fixture of inputs.fixtures) {
  validateSourceMapFixture(fixture)
  test(`Rust source-map positions match the reviewed Babel 0.28 baseline: ${fixture.id}`, () => {
    const expected = oracleById.get(fixture.id)
    assert.ok(expected, `missing Babel source-map oracle ${fixture.id}`)
    assert.equal(sha256(expected.babelCode), expected.babelCodeSha256, fixture.id)
    assert.equal(sha256(JSON.stringify(expected.babelMap)), expected.babelMapSha256, fixture.id)
    assert.deepEqual(expected.babelMap.sources, [fixture.filename], `${fixture.id}: Babel sources`)
    assert.deepEqual(
      expected.babelMap.sourcesContent,
      [fixture.source],
      `${fixture.id}: Babel sourcesContent`,
    )
    assert.deepEqual(
      expected.probes.map(probe => ({
        id: probe.id,
        kind: probe.kind,
        disposition: probe.disposition,
      })),
      fixture.probes.map(probe => ({
        id: probe.id,
        kind: probe.kind,
        disposition: probe.disposition,
      })),
      `${fixture.id}: probe manifest`,
    )

    const result = binding.transformSync({
      code: fixture.source,
      filename: fixture.filename,
      moduleId: fixture.filename,
      language: fixture.language,
      moduleKind: fixture.moduleKind,
      options: {
        dev: false,
        fineGrainedDom: true,
        sourcemap: true,
        strictGuarantee: false,
      },
    })
    assert.equal(
      result.diagnostics.some(diagnostic => diagnostic.severity === 'error'),
      false,
      `${fixture.id}: ${JSON.stringify(result.diagnostics)}`,
    )
    assert.equal(result.map?.version, 3, `${fixture.id}: Rust source map`)
    assert.deepEqual(result.map.sources, [fixture.filename], `${fixture.id}: Rust sources`)
    assert.deepEqual(
      result.map.sourcesContent,
      [fixture.source],
      `${fixture.id}: Rust sourcesContent`,
    )

    for (const [index, probe] of fixture.probes.entries()) {
      const oracleProbe = expected.probes[index]
      const replayedBabel = traceGeneratedPosition(
        expected.babelCode,
        expected.babelMap,
        probe.babel,
        `${fixture.id}:${probe.id}:frozen-babel-replay`,
      )
      assert.deepEqual(replayedBabel, oracleProbe.babel, `${fixture.id}:${probe.id}: oracle replay`)
      assert.deepEqual(
        assertProbeMapping({
          code: expected.babelCode,
          fixture,
          implementation: 'babel',
          map: expected.babelMap,
          probe,
        }),
        oracleProbe.babel,
        `${fixture.id}:${probe.id}: Babel expected position`,
      )
      const rust = assertProbeMapping({
        code: result.code,
        fixture,
        implementation: 'rust',
        map: result.map,
        probe,
      })
      if (probe.disposition === 'exact-parity') {
        assert.deepEqual(rust.original, replayedBabel.original, `${fixture.id}:${probe.id}: parity`)
      } else {
        assert.notDeepEqual(
          rust.original,
          replayedBabel.original,
          `${fixture.id}:${probe.id}: reviewed Rust precision improvement`,
        )
      }
    }
  })
}

test('Babel source-map oracle contains no unreferenced or duplicate fixtures and probes', () => {
  assert.equal(oracleById.size, oracle.fixtures.length)
  assert.deepEqual([...oracleById.keys()], expectedFixtureIds)
  assert.deepEqual(
    oracle.fixtures.map(fixture => fixture.id),
    inputs.fixtures.map(fixture => fixture.id),
  )
  const oracleProbeIds = oracle.fixtures.flatMap(fixture => fixture.probes.map(probe => probe.id))
  assert.equal(new Set(oracleProbeIds).size, oracleProbeIds.length)
})
