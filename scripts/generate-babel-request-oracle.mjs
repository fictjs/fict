#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { format } from 'prettier'

const repositoryRoot = path.resolve(import.meta.dirname, '..')
const legacyRevision = 'b99ff5b185e3eed701e2d4f3521832dac67c979f'
const compilerSourceSha256 = 'cbbaf8e6c3697e62bb5889cfebd472bada4063749140445c5098605866fd463a'
const compilerArtifactSha256 = '07c4f89c35419434b1a6762e05b08340a0c080f8ff7dd09005cb782ed9621789'
const presetSourceSha256 = '81ccc41df119b4c3a4eda0eb7f0738734977bee64a4e179f4b2940a043f7d1e4'
const presetArtifactSha256 = '19ba01dfc06eafd8e8021839f82f67775071f289011e56c433863c5afec86023'
const lockfileSha256 = '2b385eb419b90cf4f512a80ae925c2e2899bdb0e8d8c202cba8e09a9343b5af6'
const dependencyVersions = {
  '@babel/core': '7.29.7',
  '@babel/plugin-syntax-jsx': '7.28.6',
  '@babel/plugin-syntax-typescript': '7.27.1',
  '@babel/plugin-transform-modules-commonjs': '7.28.6',
  '@babel/plugin-transform-typescript': '7.28.5',
}

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
      options.input ?? path.join(repositoryRoot, 'scripts/fixtures/compiler_request_matrix.json'),
    ),
    legacyRoot: path.resolve(options['legacy-root']),
    output: path.resolve(
      options.output ??
        path.join(repositoryRoot, 'crates/fict-compiler/tests/babel_0_28_request_oracle.json'),
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

function legacyPresetOptions(request, warnings) {
  const current = request.options ?? {}
  const options = {
    dev: current.dev ?? false,
    emitModuleMetadata: false,
    onWarn: warning => warnings.push(warning),
  }
  for (const name of [
    'explain',
    'fineGrainedDom',
    'getterCache',
    'inlineDerivedMemos',
    'lazyConditional',
    'optimize',
    'optimizeLevel',
    'sourcemap',
    'strictGuarantee',
    'strictReactivity',
    'warningLevels',
    'warningsAsErrors',
  ]) {
    if (Object.hasOwn(current, name)) options[name] = current[name]
  }
  return options
}

function normalizeWarning(warning) {
  return {
    code: warning.code,
    severity: warning.severity ?? 'warning',
    message: warning.message,
    ...(warning.fileName === undefined ? {} : { fileName: warning.fileName }),
    ...(warning.line === undefined ? {} : { line: warning.line }),
    ...(warning.column === undefined ? {} : { column: warning.column }),
  }
}

function normalizeError(error) {
  const message = error instanceof Error ? error.message : String(error)
  const code = message.match(/\((FICT-[A-Z0-9-]+)\)/)?.[1] ?? 'BABEL-PARSE'
  return {
    diagnostics: [{ code, severity: 'error' }],
    errorSummary: message.split('\n', 1)[0],
  }
}

const options = parseArguments(process.argv.slice(2))
const compilerRoot = path.join(options.legacyRoot, 'packages/compiler')
const presetRoot = path.join(options.legacyRoot, 'packages/babel-preset')
const compilerArtifact = path.join(compilerRoot, 'dist/index.cjs')
const presetArtifact = path.join(presetRoot, 'dist/index.cjs')
assert.equal(statSync(path.join(compilerRoot, 'src')).isDirectory(), true)
assert.equal(statSync(path.join(presetRoot, 'src')).isDirectory(), true)
assert.equal(statSync(compilerArtifact).isFile(), true, 'missing built legacy compiler')
assert.equal(statSync(presetArtifact).isFile(), true, 'missing built legacy preset')

const compilerPackage = JSON.parse(readFileSync(path.join(compilerRoot, 'package.json'), 'utf8'))
const presetPackage = JSON.parse(readFileSync(path.join(presetRoot, 'package.json'), 'utf8'))
const rootPackage = JSON.parse(readFileSync(path.join(options.legacyRoot, 'package.json'), 'utf8'))
assert.equal(compilerPackage.version, '0.28.0')
assert.equal(presetPackage.version, '0.28.0')
assert.equal(rootPackage.packageManager, 'pnpm@9.1.1')
assert.equal(sha256(readFileSync(path.join(options.legacyRoot, 'pnpm-lock.yaml'))), lockfileSha256)
assert.equal(sourceTreeSha256(path.join(compilerRoot, 'src')), compilerSourceSha256)
assert.equal(sourceTreeSha256(path.join(presetRoot, 'src')), presetSourceSha256)
assert.equal(sha256(readFileSync(compilerArtifact)), compilerArtifactSha256)
assert.equal(sha256(readFileSync(presetArtifact)), presetArtifactSha256)

const require = createRequire(path.join(presetRoot, 'package.json'))
for (const [name, expectedVersion] of Object.entries(dependencyVersions)) {
  assert.equal(require(`${name}/package.json`).version, expectedVersion, `${name} version`)
}
const { transformSync } = require('@babel/core')
const presetModule = require(presetArtifact)
const preset = presetModule.default ?? presetModule

const inputText = readFileSync(options.input, 'utf8')
const input = JSON.parse(inputText)
assert.equal(input.schemaVersion, 1)
assert.ok(Array.isArray(input.cases))
const legacyCases = input.cases.filter(fixture => fixture.legacy === true)
const ids = new Set()

const previousNodeEnv = process.env.NODE_ENV
const previousStrictEnv = process.env.FICT_STRICT_GUARANTEE
process.env.NODE_ENV = 'test'
delete process.env.FICT_STRICT_GUARANTEE

let fixtures
try {
  fixtures = legacyCases.map(fixture => {
    assert.equal(ids.has(fixture.id), false, `duplicate fixture ${fixture.id}`)
    ids.add(fixture.id)
    assert.equal(fixture.request.language, undefined, `${fixture.id} uses native-only language`)
    assert.equal(fixture.request.moduleKind, undefined, `${fixture.id} uses native-only moduleKind`)
    assert.equal(fixture.request.metadata, undefined, `${fixture.id} uses native-only metadata`)
    assert.equal(
      fixture.request.publicModuleId,
      undefined,
      `${fixture.id} uses native-only public id`,
    )
    const warnings = []
    try {
      const transformed = transformSync(fixture.request.code, {
        filename: fixture.request.filename,
        configFile: false,
        babelrc: false,
        ...(fixture.request.inputSourceMap
          ? { inputSourceMap: fixture.request.inputSourceMap }
          : {}),
        presets: [[preset, legacyPresetOptions(fixture.request, warnings)]],
      })
      assert.equal(typeof transformed?.code, 'string', `${fixture.id} Babel output`)
      const babelCode = transformed.code
      return {
        id: fixture.id,
        status: 'ok',
        diagnostics: warnings.map(normalizeWarning),
        babelCodeSha256: sha256(babelCode),
        babelCode,
        map: transformed.map ?? null,
        explain: transformed.metadata?.fictExplain ?? null,
      }
    } catch (error) {
      const normalized = normalizeError(error)
      return {
        id: fixture.id,
        status: 'error',
        diagnostics: normalized.diagnostics,
        babelCodeSha256: null,
        babelCode: null,
        map: null,
        explain: null,
        errorSummary: normalized.errorSummary,
      }
    }
  })
} finally {
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = previousNodeEnv
  if (previousStrictEnv === undefined) delete process.env.FICT_STRICT_GUARANTEE
  else process.env.FICT_STRICT_GUARANTEE = previousStrictEnv
}

const oracle = {
  schemaVersion: 1,
  provenance: {
    legacyRelease: '0.28.0',
    legacyRevision,
    compilerSourceSha256,
    compilerArtifactSha256,
    presetSourceSha256,
    presetArtifactSha256,
    lockfileSha256,
    packageManager: rootPackage.packageManager,
    babelDependencies: dependencyVersions,
    environment: { NODE_ENV: 'test', FICT_STRICT_GUARANTEE: 'unset' },
    requestInputsSha256: sha256(inputText),
  },
  fixtures,
}
writeFileSync(options.output, await format(JSON.stringify(oracle), { parser: 'json' }))
process.stdout.write(`${JSON.stringify({ output: options.output, fixtures: fixtures.length })}\n`)
