#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { format, resolveConfig } from 'prettier'

import {
  assertProbeMapping,
  validateSourceMapFixture,
} from './lib/compiler-source-map-semantic-harness.mjs'

const repositoryRoot = path.resolve(import.meta.dirname, '..')
const legacyRevision = 'b99ff5b185e3eed701e2d4f3521832dac67c979f'
const legacySourceSha256 = 'cbbaf8e6c3697e62bb5889cfebd472bada4063749140445c5098605866fd463a'
const legacyArtifactSha256 = '07c4f89c35419434b1a6762e05b08340a0c080f8ff7dd09005cb782ed9621789'
const legacyLockfileSha256 = '2b385eb419b90cf4f512a80ae925c2e2899bdb0e8d8c202cba8e09a9343b5af6'
const babelDependencyVersions = {
  '@babel/core': '7.29.7',
  '@babel/plugin-transform-modules-commonjs': '7.28.6',
  '@babel/plugin-transform-typescript': '7.28.5',
}
const traceMappingVersion = '0.3.31'

function parseArguments(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`Expected --name value arguments, received ${argv.slice(index).join(' ')}`)
    }
    options[name.slice(2)] = value
  }
  const unknown = Object.keys(options).filter(
    name => !['input', 'legacy-root', 'output'].includes(name),
  )
  if (unknown.length > 0) throw new Error(`Unknown argument(s): ${unknown.join(', ')}`)
  if (!options['legacy-root']) throw new Error('--legacy-root is required')
  return {
    input: path.resolve(
      options.input ??
        path.join(repositoryRoot, 'scripts/fixtures/babel_0_28_source_map_inputs.json'),
    ),
    legacyRoot: path.resolve(options['legacy-root']),
    output: path.resolve(
      options.output ??
        path.join(repositoryRoot, 'crates/fict-compiler/tests/babel_0_28_source_map_oracle.json'),
    ),
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function sourceTreeSha256(root) {
  const files = []
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(absolute)
      else if (entry.isFile()) files.push(absolute)
    }
  }
  visit(root)
  files.sort()
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(path.relative(root, file).split(path.sep).join('/'))
    hash.update('\0')
    hash.update(readFileSync(file))
    hash.update('\0')
  }
  return hash.digest('hex')
}

function normalizedDiagnostics(warnings) {
  return warnings.map(warning => ({
    code: warning.code,
    severity: warning.severity ?? 'warning',
    message: warning.message,
    ...(warning.fileName === undefined ? {} : { fileName: warning.fileName }),
    ...(warning.line === undefined ? {} : { line: warning.line }),
    ...(warning.column === undefined ? {} : { column: warning.column }),
  }))
}

const options = parseArguments(process.argv.slice(2))
const compilerRoot = path.join(options.legacyRoot, 'packages/compiler')
const compilerSource = path.join(compilerRoot, 'src')
const compilerArtifact = path.join(compilerRoot, 'dist/index.cjs')
assert.equal(statSync(compilerSource).isDirectory(), true, 'missing legacy compiler source')
assert.equal(statSync(compilerArtifact).isFile(), true, 'missing built legacy compiler artifact')

const legacyPackage = JSON.parse(readFileSync(path.join(compilerRoot, 'package.json'), 'utf8'))
const legacyRootPackage = JSON.parse(
  readFileSync(path.join(options.legacyRoot, 'package.json'), 'utf8'),
)
assert.equal(legacyPackage.version, '0.28.0', 'legacy compiler package version')
assert.equal(legacyRootPackage.packageManager, 'pnpm@9.1.1', 'legacy package manager')
assert.equal(
  sha256(readFileSync(path.join(options.legacyRoot, 'pnpm-lock.yaml'))),
  legacyLockfileSha256,
  'legacy lockfile digest',
)
assert.equal(sourceTreeSha256(compilerSource), legacySourceSha256, 'legacy compiler source digest')
assert.equal(sha256(readFileSync(compilerArtifact)), legacyArtifactSha256, 'legacy artifact digest')

const legacyRequire = createRequire(path.join(compilerRoot, 'package.json'))
for (const [name, expectedVersion] of Object.entries(babelDependencyVersions)) {
  assert.equal(legacyRequire(`${name}/package.json`).version, expectedVersion, `${name} version`)
}
const repositoryRequire = createRequire(import.meta.url)
assert.equal(
  repositoryRequire('@jridgewell/trace-mapping/package.json').version,
  traceMappingVersion,
  '@jridgewell/trace-mapping version',
)

const { transformSync } = legacyRequire('@babel/core')
const transformTypescript = legacyRequire('@babel/plugin-transform-typescript')
const transformCommonJs = legacyRequire('@babel/plugin-transform-modules-commonjs')
const compilerModule = legacyRequire(compilerArtifact)
const compiler = compilerModule.default ?? compilerModule

const inputText = readFileSync(options.input, 'utf8')
const input = JSON.parse(inputText)
const harnessText = readFileSync(
  path.join(repositoryRoot, 'scripts/lib/compiler-source-map-semantic-harness.mjs'),
  'utf8',
)
assert.equal(input.schemaVersion, 1)
assert.ok(Array.isArray(input.fixtures))

const fixtureIds = new Set()
const probeIds = new Set()
const fixtures = []
for (const fixture of input.fixtures) {
  validateSourceMapFixture(fixture)
  assert.equal(fixtureIds.has(fixture.id), false, `duplicate fixture ${fixture.id}`)
  fixtureIds.add(fixture.id)
  for (const probe of fixture.probes) {
    assert.equal(probeIds.has(probe.id), false, `duplicate probe ${probe.id}`)
    probeIds.add(probe.id)
  }

  const warnings = []
  const transformed = transformSync(fixture.source, {
    filename: fixture.filename,
    sourceFileName: fixture.filename,
    sourceMaps: true,
    configFile: false,
    babelrc: false,
    sourceType: 'module',
    parserOpts: {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
      allowReturnOutsideFunction: true,
    },
    plugins: [
      [
        transformTypescript,
        {
          isTSX: fixture.language.endsWith('x'),
          allExtensions: true,
          allowDeclareFields: true,
          allowNamespaces: true,
        },
      ],
      [
        compiler,
        {
          dev: false,
          emitModuleMetadata: false,
          fineGrainedDom: true,
          sourcemap: true,
          strictGuarantee: false,
          onWarn: warning => warnings.push(warning),
        },
      ],
      ...(fixture.moduleKind === 'commonjs' ? [transformCommonJs] : []),
    ],
    generatorOpts: { compact: false },
  })
  assert.equal(typeof transformed?.code, 'string', `${fixture.id}: Babel output`)
  assert.equal(transformed?.map?.version, 3, `${fixture.id}: Babel source map`)
  assert.deepEqual(transformed.map.sources, [fixture.filename], `${fixture.id}: Babel sources`)
  assert.deepEqual(
    transformed.map.sourcesContent,
    [fixture.source],
    `${fixture.id}: Babel sourcesContent`,
  )

  const babelMapText = JSON.stringify(transformed.map)
  fixtures.push({
    id: fixture.id,
    babelDiagnostics: normalizedDiagnostics(warnings),
    babelCodeSha256: sha256(transformed.code),
    babelMapSha256: sha256(babelMapText),
    babelCode: transformed.code,
    babelMap: transformed.map,
    probes: fixture.probes.map(probe => ({
      id: probe.id,
      kind: probe.kind,
      disposition: probe.disposition,
      babel: assertProbeMapping({
        code: transformed.code,
        fixture,
        implementation: 'babel',
        map: transformed.map,
        probe,
      }),
    })),
  })
}

const oracle = {
  schemaVersion: 1,
  provenance: {
    legacyRelease: '0.28.0',
    legacyRevision,
    legacyCompilerSourceSha256: legacySourceSha256,
    legacyCompilerArtifactSha256: legacyArtifactSha256,
    legacyLockfileSha256,
    legacyPackageManager: legacyRootPackage.packageManager,
    babelDependencies: babelDependencyVersions,
    traceMappingDependency: `@jridgewell/trace-mapping@${traceMappingVersion}`,
    oracleInputsSha256: sha256(inputText),
    sourceMapHarnessSha256: sha256(harnessText),
    comparisonModel: 'frozen-babel-generated-tokens-vs-live-rust-authored-original-positions',
  },
  fixtures,
}
writeFileSync(
  options.output,
  await format(JSON.stringify(oracle), {
    ...(await resolveConfig(path.join(repositoryRoot, 'package.json'))),
    parser: 'json',
  }),
)
process.stdout.write(
  `${JSON.stringify({ output: options.output, fixtures: fixtures.length, probes: probeIds.size })}\n`,
)
