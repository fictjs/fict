import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import test from 'node:test'

const require = createRequire(import.meta.url)
const repositoryRoot = path.resolve(import.meta.dirname, '..')
const read = relative => readFileSync(path.join(repositoryRoot, relative), 'utf8')
const inputText = read('scripts/fixtures/compiler_request_matrix.json')
const matrix = JSON.parse(inputText)
const oracle = JSON.parse(read('crates/fict-compiler/tests/babel_0_28_request_oracle.json'))
const nativePath = path.resolve(
  process.env.FICT_COMPILER_NATIVE_PATH ??
    path.join(repositoryRoot, 'target/release/fict_compiler_napi.node'),
)
const binding = require(nativePath)
const sha256 = value => createHash('sha256').update(value).digest('hex')
const sha256Pattern = /^[0-9a-f]{64}$/
const oracleById = new Map(oracle.fixtures.map(fixture => [fixture.id, fixture]))

function resultStatus(result) {
  return result.diagnostics.some(diagnostic => diagnostic.severity === 'error') ? 'error' : 'ok'
}

function deterministicResult(result) {
  return {
    ...result,
    stats: result.stats
      ? {
          ...result.stats,
          stageDurationsNs: {},
        }
      : null,
  }
}

function diagnosticSignatures(diagnostics, legacy) {
  return diagnostics.map(diagnostic => ({
    code: diagnostic.code,
    severity: diagnostic.severity,
    ...(legacy ? {} : { guaranteeClass: diagnostic.guaranteeClass }),
  }))
}

function assertMap(actual, expected, context) {
  assert.ok(actual, `${context}: missing source map`)
  for (const name of [
    'version',
    'sourceRoot',
    'sources',
    'sourcesContent',
    'x_google_ignoreList',
  ]) {
    if (Object.hasOwn(expected, name)) {
      assert.deepEqual(actual[name], expected[name], `${context}: map.${name}`)
    }
  }
  if (expected.mappingsNonEmpty) {
    assert.equal(typeof actual.mappings, 'string', `${context}: map.mappings type`)
    assert.notEqual(actual.mappings, '', `${context}: map.mappings`)
  }
}

function assertExplain(actual, expected, context) {
  assert.ok(actual, `${context}: missing explanation`)
  assert.equal(actual.version, expected.version, `${context}: explain version`)
  assert.equal(actual.fileName, expected.fileName, `${context}: explain fileName`)
  assert.deepEqual(
    actual.events.filter(event => event.kind.startsWith('source-')).map(event => event.kind),
    expected.sourceEventKinds,
    `${context}: explain source event kinds`,
  )
}

function assertExpected(actual, expected, context, legacy) {
  const code = legacy ? actual.babelCode : actual.code
  const status = legacy ? actual.status : resultStatus(actual)
  assert.equal(status, expected.status, `${context}: status`)
  assert.deepEqual(
    diagnosticSignatures(actual.diagnostics, legacy),
    expected.diagnostics ?? [],
    `${context}: diagnostics`,
  )
  for (const value of expected.codeIncludes ?? []) {
    assert.ok(code?.includes(value), `${context}: output must include ${JSON.stringify(value)}`)
  }
  for (const value of expected.codeExcludes ?? []) {
    assert.equal(
      code?.includes(value) ?? false,
      false,
      `${context}: output must exclude ${JSON.stringify(value)}`,
    )
  }
  if (expected.map) assertMap(actual.map, expected.map, context)
  if (expected.explain) assertExplain(actual.explain, expected.explain, context)
  for (const name of [
    'moduleMetadata',
    'metadataDependencies',
    'unresolvedMetadataRequests',
    'metadataIncomplete',
  ]) {
    if (Object.hasOwn(expected, name)) {
      assert.deepEqual(actual[name], expected[name], `${context}: ${name}`)
    }
  }
  if (expected.artifacts) {
    assert.equal(actual.artifacts.length, expected.artifacts.length, `${context}: artifacts`)
    expected.artifacts.forEach((artifact, index) => {
      const observed = actual.artifacts[index]
      assert.equal(observed.id, artifact.id, `${context}: artifact id`)
      assert.equal(observed.kind, artifact.kind, `${context}: artifact kind`)
      assert.deepEqual(observed.map?.sources, artifact.mapSources, `${context}: artifact map`)
    })
  }
}

function normalizedSource(map, index = 0) {
  const source = map.sources[index]
  if (!map.sourceRoot || path.posix.isAbsolute(source)) return source
  return path.posix.join(map.sourceRoot, source)
}

test('Babel request oracle has exact compiler and preset provenance', () => {
  assert.equal(matrix.schemaVersion, 1)
  assert.equal(oracle.schemaVersion, 1)
  assert.deepEqual(oracle.provenance, {
    legacyRelease: '0.28.0',
    legacyRevision: 'b99ff5b185e3eed701e2d4f3521832dac67c979f',
    compilerSourceSha256: 'cbbaf8e6c3697e62bb5889cfebd472bada4063749140445c5098605866fd463a',
    compilerArtifactSha256: '07c4f89c35419434b1a6762e05b08340a0c080f8ff7dd09005cb782ed9621789',
    presetSourceSha256: '81ccc41df119b4c3a4eda0eb7f0738734977bee64a4e179f4b2940a043f7d1e4',
    presetArtifactSha256: '19ba01dfc06eafd8e8021839f82f67775071f289011e56c433863c5afec86023',
    lockfileSha256: '2b385eb419b90cf4f512a80ae925c2e2899bdb0e8d8c202cba8e09a9343b5af6',
    packageManager: 'pnpm@9.1.1',
    babelDependencies: {
      '@babel/core': '7.29.7',
      '@babel/plugin-syntax-jsx': '7.28.6',
      '@babel/plugin-syntax-typescript': '7.27.1',
      '@babel/plugin-transform-modules-commonjs': '7.28.6',
      '@babel/plugin-transform-typescript': '7.28.5',
    },
    environment: { NODE_ENV: 'test', FICT_STRICT_GUARANTEE: 'unset' },
    requestInputsSha256: sha256(inputText),
  })
  assert.deepEqual(
    oracle.fixtures.map(fixture => fixture.id),
    matrix.cases.filter(fixture => fixture.legacy).map(fixture => fixture.id),
  )
  for (const fixture of oracle.fixtures) {
    if (fixture.status === 'ok') {
      assert.match(fixture.babelCodeSha256, sha256Pattern, fixture.id)
      assert.equal(sha256(fixture.babelCode), fixture.babelCodeSha256, fixture.id)
    } else {
      assert.equal(fixture.babelCode, null, fixture.id)
      assert.equal(fixture.babelCodeSha256, null, fixture.id)
      assert.equal(typeof fixture.errorSummary, 'string', fixture.id)
    }
  }
})

test('request matrix covers every source identity and structured request dimension', () => {
  const ids = new Set(matrix.cases.map(fixture => fixture.id))
  assert.equal(ids.size, matrix.cases.length)
  const inferredExtensions = matrix.cases
    .filter(fixture => fixture.id.startsWith('infer-'))
    .map(fixture => path.extname(fixture.request.filename.split(/[?#]/, 1)[0]))
    .sort()
  assert.deepEqual(inferredExtensions, [
    '.cjs',
    '.cts',
    '.js',
    '.jsx',
    '.mjs',
    '.mts',
    '.ts',
    '.tsx',
  ])
  assert.ok(matrix.cases.some(fixture => fixture.request.language === 'jsx'))
  assert.ok(matrix.cases.some(fixture => fixture.request.moduleKind === 'commonjs'))
  assert.ok(matrix.cases.some(fixture => fixture.request.moduleKind === 'script'))
  assert.ok(matrix.cases.some(fixture => fixture.request.moduleKind === 'unambiguous'))
  assert.ok(matrix.cases.some(fixture => fixture.request.inputSourceMap))
  assert.ok(matrix.cases.some(fixture => fixture.request.options?.explain))
  assert.ok(matrix.cases.some(fixture => fixture.request.metadata?.length > 0))
  assert.ok(matrix.cases.some(fixture => fixture.request.publicModuleId))
  assert.ok(matrix.cases.some(fixture => fixture.request.options === undefined))
})

for (const fixture of matrix.cases.filter(fixture => fixture.legacy)) {
  test(`frozen Babel 0.28 request behavior: ${fixture.id}`, () => {
    const expected = oracleById.get(fixture.id)
    assert.ok(expected, `missing Babel request oracle ${fixture.id}`)
    assertExpected(expected, fixture.legacyExpected, `Babel ${fixture.id}`, true)
  })
}

for (const fixture of matrix.cases) {
  test(`native request contract: ${fixture.id}`, () => {
    const first = binding.transformSync(fixture.request)
    const second = binding.transformSync(fixture.request)
    assert.deepEqual(
      deterministicResult(second),
      deterministicResult(first),
      `${fixture.id}: nondeterministic native result`,
    )
    assertExpected(first, fixture.currentExpected, `Rust ${fixture.id}`, false)

    const legacy = oracleById.get(fixture.id)
    switch (fixture.compatibilityPolicy) {
      case 'feature-parity':
      case 'syntax-rejection-parity':
        assert.equal(resultStatus(first), legacy.status, `${fixture.id}: Babel/Rust status`)
        break
      case 'strict-policy-parity':
        assert.deepEqual(
          diagnosticSignatures(first.diagnostics, true),
          diagnosticSignatures(legacy.diagnostics, true),
          `${fixture.id}: strict diagnostic parity`,
        )
        break
      case 'rust-capability-expansion':
        assert.equal(legacy.status, 'error')
        assert.equal(resultStatus(first), 'ok')
        break
      case 'jsx-extension-required':
        assert.equal(legacy.status, 'ok')
        assert.equal(resultStatus(first), 'error')
        break
      case 'source-map-normalization':
        assert.equal(normalizedSource(first.map), normalizedSource(legacy.map))
        assert.deepEqual(first.map.sourcesContent, legacy.map.sourcesContent)
        break
      case 'explain-normalization':
        assert.deepEqual(
          first.explain.events
            .filter(event => event.kind.startsWith('source-'))
            .map(event => event.kind),
          legacy.explain.events
            .filter(event => event.kind.startsWith('source-'))
            .map(event => event.kind),
        )
        break
      case 'native-host-protocol':
        assert.equal(legacy, undefined)
        break
      default:
        assert.fail(`${fixture.id}: unreviewed compatibility policy ${fixture.compatibilityPolicy}`)
    }
  })
}

test('Babel request oracle has no unreferenced fixtures', () => {
  assert.equal(oracleById.size, oracle.fixtures.length)
  assert.ok(matrix.cases.every(fixture => fixture.legacy || !oracleById.has(fixture.id)))
})
