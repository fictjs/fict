import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'

import { normalizeAnalysis, normalizeExplain } from './lib/compiler-tooling-semantic-harness.mjs'

const require = createRequire(import.meta.url)
const repositoryRoot = path.resolve(import.meta.dirname, '..')
const read = relative => readFileSync(path.join(repositoryRoot, relative), 'utf8')
const inputsText = read('scripts/fixtures/babel_0_28_tooling_semantic_inputs.json')
const inputs = JSON.parse(inputsText)
const oracle = JSON.parse(
  read('crates/fict-compiler/tests/babel_0_28_tooling_semantic_oracle.json'),
)
const binding = require(path.join(repositoryRoot, 'target/release/fict_compiler_napi.node'))
const sha256 = value => createHash('sha256').update(value).digest('hex')
const sorted = values => [...values].sort()
const diagnosticLocations = diagnostics =>
  diagnostics.map(({ severity: _severity, ...diagnostic }) => diagnostic)
const diagnosticSignatures = diagnostics =>
  diagnostics.map(({ code, severity }) => `${code}:${severity}`)
const emptyRegionSemantics = {
  declarations: [],
  dependencies: [],
  hasControlFlow: false,
  hasReactiveWrites: false,
}

function setComparison(babelCapabilities, rustCapabilities) {
  const babel = new Set(babelCapabilities)
  const rust = new Set(rustCapabilities)
  return {
    shared: sorted([...babel].filter(capability => rust.has(capability))),
    babelOnly: sorted([...babel].filter(capability => !rust.has(capability))),
    rustOnly: sorted([...rust].filter(capability => !babel.has(capability))),
  }
}

function compileRust(fixture) {
  const request = fixture.request
  const transformed = binding.transformSync({
    ...request,
    options: { ...request.options, explain: true },
  })
  assert.equal(
    transformed.diagnostics.some(diagnostic => diagnostic.severity === 'error'),
    false,
    `${fixture.id}: ${JSON.stringify(transformed.diagnostics)}`,
  )
  const analysis = binding.analyzeSync({
    code: request.code,
    filename: request.filename,
    language: request.language,
    moduleKind: request.moduleKind,
    options: {
      includeRegions: true,
      includeDiagnostics: true,
      verbosity: 'verbose',
      compilerOptions: request.options,
    },
  })
  return {
    explain: normalizeExplain(transformed.explain, request.code),
    analysis: normalizeAnalysis(analysis),
  }
}

test('Babel 0.28 tooling semantic oracle has exact independent provenance', () => {
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
      '@babel/plugin-transform-typescript': '7.28.5',
    },
    oracleInputsSha256: sha256(inputsText),
    toolingHarnessSha256: sha256(read('scripts/lib/compiler-tooling-semantic-harness.mjs')),
  })
  assert.equal(inputs.fixtures.length, 4)
  assert.equal(oracle.fixtures.length, inputs.fixtures.length)
})

const oracleById = new Map(oracle.fixtures.map(fixture => [fixture.id, fixture]))
for (const fixture of inputs.fixtures) {
  test(`Rust matches reviewed Babel 0.28 tooling semantics: ${fixture.id}`, () => {
    const expected = oracleById.get(fixture.id)
    assert.ok(expected, `missing Babel tooling oracle ${fixture.id}`)
    assert.equal(sha256(expected.babelCode), expected.babelCodeSha256, fixture.id)
    assert.equal(
      sha256(JSON.stringify(expected.babelExplain)),
      expected.babelExplainSha256,
      fixture.id,
    )
    assert.equal(
      sha256(JSON.stringify(expected.babelAnalysis)),
      expected.babelAnalysisSha256,
      fixture.id,
    )

    const babel = {
      explain: normalizeExplain(expected.babelExplain, fixture.request.code),
      analysis: normalizeAnalysis(expected.babelAnalysis),
    }
    const rust = compileRust(fixture)

    for (const result of [babel, rust]) {
      assert.equal(result.explain.version, 1, fixture.id)
      assert.equal(result.explain.fileName, fixture.request.filename, fixture.id)
      assert.equal(result.analysis.fileName, fixture.request.filename, fixture.id)
      assert.deepEqual(result.explain.diagnosticEvents, result.explain.diagnostics, fixture.id)
      assert.deepEqual(result.explain.runtimeHelperEvents, result.explain.helpers, fixture.id)
    }
    assert.deepEqual(
      expected.babelWarnings.map(({ code, line, column }) => ({ code, line, column })),
      babel.explain.diagnostics,
      `${fixture.id} frozen warning callback`,
    )
    assert.deepEqual(
      diagnosticLocations(babel.analysis.diagnostics),
      babel.explain.diagnostics,
      `${fixture.id} frozen analyze/explain diagnostics`,
    )
    assert.deepEqual(rust.explain.sourceEvents, babel.explain.sourceEvents, fixture.id)
    assert.deepEqual(
      setComparison(babel.explain.helperCapabilities, rust.explain.helperCapabilities),
      fixture.comparison.helperCapabilities,
      `${fixture.id} helper capability disposition`,
    )

    assert.ok(
      ['exact', 'rust-binding-coverage-expansion', 'rust-control-span-precision'].includes(
        fixture.comparison.diagnosticDisposition,
      ),
      `${fixture.id} diagnostic disposition`,
    )
    assert.deepEqual(rust.analysis.diagnostics, fixture.comparison.rustDiagnostics, fixture.id)
    assert.deepEqual(
      rust.explain.diagnostics,
      diagnosticLocations(fixture.comparison.rustDiagnostics),
      `${fixture.id} native analyze/explain diagnostics`,
    )
    if (fixture.comparison.diagnosticDisposition === 'exact') {
      assert.deepEqual(rust.analysis.diagnostics, babel.analysis.diagnostics, fixture.id)
    } else if (fixture.comparison.diagnosticDisposition === 'rust-control-span-precision') {
      assert.deepEqual(
        diagnosticSignatures(rust.analysis.diagnostics),
        diagnosticSignatures(babel.analysis.diagnostics),
        fixture.id,
      )
      assert.notDeepEqual(rust.analysis.diagnostics, babel.analysis.diagnostics, fixture.id)
    } else {
      assert.equal(babel.analysis.diagnostics.length, 1, fixture.id)
      assert.ok(rust.analysis.diagnostics.length > babel.analysis.diagnostics.length, fixture.id)
      assert.ok(
        rust.analysis.diagnostics.every(
          diagnostic =>
            diagnostic.code === babel.analysis.diagnostics[0].code &&
            diagnostic.severity === babel.analysis.diagnostics[0].severity,
        ),
        fixture.id,
      )
    }

    assert.deepEqual(babel.analysis.anonymousComponents, [], fixture.id)
    const babelNamed = new Map(
      babel.analysis.namedComponents.map(component => [component.name, component]),
    )
    const rustNamed = new Map(
      rust.analysis.namedComponents.map(component => [component.name, component]),
    )
    assert.equal(babelNamed.size, babel.analysis.namedComponents.length, fixture.id)
    assert.equal(rustNamed.size, rust.analysis.namedComponents.length, fixture.id)

    for (const [name, legacyComponent] of babelNamed) {
      const nativeComponent = rustNamed.get(name)
      assert.ok(nativeComponent, `${fixture.id}: missing native component ${name}`)
      assert.deepEqual(
        {
          name: nativeComponent.name,
          startLine: nativeComponent.startLine,
          endLine: nativeComponent.endLine,
        },
        {
          name: legacyComponent.name,
          startLine: legacyComponent.startLine,
          endLine: legacyComponent.endLine,
        },
        `${fixture.id}: ${name} boundary`,
      )
      assert.ok(
        legacyComponent.traceKeys.every(key => nativeComponent.traceKeys.includes(key)),
        `${fixture.id}: ${name} legacy trace subset`,
      )
      assert.deepEqual(
        nativeComponent.traceKeys.filter(key => !legacyComponent.traceKeys.includes(key)),
        fixture.comparison.traceAdditions[name],
        `${fixture.id}: ${name} reviewed trace additions`,
      )
      assert.deepEqual(
        {
          declarations: nativeComponent.regionSemantics.declarations,
          hasControlFlow: nativeComponent.regionSemantics.hasControlFlow,
          hasReactiveWrites: nativeComponent.regionSemantics.hasReactiveWrites,
        },
        {
          declarations: legacyComponent.regionSemantics.declarations,
          hasControlFlow: legacyComponent.regionSemantics.hasControlFlow,
          hasReactiveWrites: legacyComponent.regionSemantics.hasReactiveWrites,
        },
        `${fixture.id}: ${name} shared region semantics`,
      )
      const dependencyDifference = fixture.comparison.regionDependencyDifferences[name]
      if (dependencyDifference === undefined) {
        assert.deepEqual(
          nativeComponent.regionSemantics.dependencies,
          legacyComponent.regionSemantics.dependencies,
          `${fixture.id}: ${name} region dependencies`,
        )
      } else {
        assert.ok(
          [
            'native-binding-resolved-dependencies',
            'native-iteration-dependency-ownership',
            'native-prop-region-expansion',
            'native-structured-region-expansion',
          ].includes(dependencyDifference.policy),
          `${fixture.id}: ${name} region dependency policy`,
        )
        assert.deepEqual(
          {
            babel: legacyComponent.regionSemantics.dependencies,
            rust: nativeComponent.regionSemantics.dependencies,
          },
          { babel: dependencyDifference.babel, rust: dependencyDifference.rust },
          `${fixture.id}: ${name} reviewed region dependencies`,
        )
      }
    }
    assert.deepEqual(
      Object.keys(fixture.comparison.traceAdditions).sort(),
      [...babelNamed.keys()].sort(),
      `${fixture.id} trace policy coverage`,
    )
    assert.ok(
      Object.keys(fixture.comparison.regionDependencyDifferences).every(name =>
        babelNamed.has(name),
      ),
      `${fixture.id} region dependency policy coverage`,
    )

    const rustOnlyNamed = rust.analysis.namedComponents
      .filter(component => !babelNamed.has(component.name))
      .map(({ regionSemantics: _regions, ...component }) => component)
    assert.deepEqual(
      rustOnlyNamed,
      fixture.comparison.rustOnlyNamedComponents,
      `${fixture.id} reviewed native component expansion`,
    )
    assert.deepEqual(
      [...rustNamed.keys()].sort(),
      [
        ...babelNamed.keys(),
        ...fixture.comparison.rustOnlyNamedComponents.map(component => component.name),
      ].sort(),
      `${fixture.id} named component coverage`,
    )
    assert.deepEqual(
      Object.fromEntries(
        rust.analysis.namedComponents.map(component => [component.name, component.regionSemantics]),
      ),
      fixture.comparison.rustRegionSemantics,
      `${fixture.id} reviewed native region semantics`,
    )

    assert.deepEqual(
      rust.analysis.anonymousComponents,
      fixture.comparison.rustAnonymousCallbackLines.map(line => ({
        name: '<anonymous>',
        startLine: line,
        endLine: line,
        traceKeys: [`${line}:once`],
        regionSemantics: emptyRegionSemantics,
      })),
      `${fixture.id} native structured callback expansion`,
    )
  })
}

test('Babel tooling oracle contains no unreferenced or duplicate fixtures', () => {
  assert.equal(oracleById.size, oracle.fixtures.length)
  assert.deepEqual([...oracleById.keys()].sort(), inputs.fixtures.map(fixture => fixture.id).sort())
  assert.deepEqual(
    inputs.fixtures.map(fixture => [fixture.id, fixture.comparison.diagnosticDisposition]),
    [
      ['reactive-control', 'rust-control-span-precision'],
      ['runtime-memos', 'rust-binding-coverage-expansion'],
      ['hidden-jsx', 'exact'],
      ['unicode-regions', 'rust-control-span-precision'],
    ],
  )
})
