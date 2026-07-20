#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { format, resolveConfig } from 'prettier'

import { buildCorpusRequestPolicy } from './lib/compiler-corpus-request-policy.mjs'
import { buildDiagnosticDeviationReview } from './lib/compiler-diagnostic-deviation-review.mjs'

const require = createRequire(import.meta.url)
const repositoryRoot = path.resolve(import.meta.dirname, '..')
const corpusFormatPath = path.join(
  repositoryRoot,
  'crates/fict-compiler/tests/rust_frozen_codegen_corpus.json',
)
const diagnosticReviewPath = path.join(
  repositoryRoot,
  'scripts/fixtures/compiler_diagnostic_deviation_reviews.json',
)
const requestPolicyPath = path.join(
  repositoryRoot,
  'scripts/fixtures/compiler_corpus_request_policy.json',
)
const rustAcceptanceReviewPath = path.join(
  repositoryRoot,
  'scripts/fixtures/compiler_rust_acceptance_reviews.json',
)
const expectedAuditSha256 = '676b022516c01b525d7e2a316e5b072eae2ee1532b2bb103573543900f13b67f'
const expectedExtraction = {
  extracted: 1974,
  unique: 1892,
}
const legacyRevision = 'b99ff5b185e3eed701e2d4f3521832dac67c979f'
const legacyCompilerSourceSha256 =
  'cbbaf8e6c3697e62bb5889cfebd472bada4063749140445c5098605866fd463a'
const legacyCompilerArtifactSha256 =
  '07c4f89c35419434b1a6762e05b08340a0c080f8ff7dd09005cb782ed9621789'
const legacyLockfileSha256 = '2b385eb419b90cf4f512a80ae925c2e2899bdb0e8d8c202cba8e09a9343b5af6'
const legacyAuditFilename = '/mnt/data/fict_audit/legacy/fict-0.28.0/fixture.tsx'
const legacyDependencyVersions = {
  '@babel/core': '7.29.7',
  '@babel/plugin-transform-typescript': '7.28.5',
}
const rustAcceptanceReview = JSON.parse(readFileSync(rustAcceptanceReviewPath, 'utf8'))
assert.equal(rustAcceptanceReview.schemaVersion, 1)
const rustAcceptanceReviewsById = new Map(
  rustAcceptanceReview.reviews.map(review => [review.id, review]),
)
assert.equal(
  rustAcceptanceReviewsById.size,
  rustAcceptanceReview.reviews.length,
  'duplicate Rust acceptance review id',
)
const deviationPolicies = {
  ...Object.fromEntries(
    Object.entries(rustAcceptanceReview.policies).map(([policy, metadata]) => [
      policy,
      metadata.description,
    ]),
  ),
  'narrow-component-role':
    'Rust requires an explicit component role before component-context macros are legal; indirect or anonymous owners fail closed.',
  'structured-hook-return':
    'Rust 0.31 enforces readonly and setter rules for structured same-module hook return accessors.',
  'standard-decorator-fail-closed':
    'Rust rejects standard decorators until a target-compatible transform can produce runnable JavaScript.',
  'strict-reactivity-fail-closed':
    'Rust strictGuarantee rejects reactive control-flow region fallback instead of silently accepting output that requires R006 re-execution.',
}
const expectedPolicyCounts = {
  ...rustAcceptanceReview.policyCounts,
  'narrow-component-role': 24,
  'structured-hook-return': 6,
  'standard-decorator-fail-closed': 3,
  'strict-reactivity-fail-closed': 4,
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
    name =>
      !['diagnostic-review-output', 'input', 'legacy-root', 'native-path', 'output'].includes(name),
  )
  if (unknown.length > 0) throw new Error(`Unknown argument(s): ${unknown.join(', ')}`)
  if (!options.input) throw new Error('--input is required')
  if (!options['legacy-root']) throw new Error('--legacy-root is required')
  return {
    input: path.resolve(options.input),
    legacyRoot: path.resolve(options['legacy-root']),
    nativePath: path.resolve(
      options['native-path'] ?? path.join(repositoryRoot, 'target/release/fict_compiler_napi.node'),
    ),
    output: path.resolve(options.output ?? corpusFormatPath),
    diagnosticReviewOutput: options['diagnostic-review-output']
      ? path.resolve(options['diagnostic-review-output'])
      : null,
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

function resultStatus(diagnostics) {
  return diagnostics.some(diagnostic => diagnostic.severity === 'error') ? 'error' : 'ok'
}

function expectedDiagnostics(diagnostics) {
  return diagnostics.map(({ code, guaranteeClass, severity }) => ({
    code,
    severity,
    guaranteeClass,
  }))
}

function deterministicResult(result) {
  return {
    protocolVersion: result.protocolVersion,
    code: result.code,
    map: result.map,
    diagnostics: result.diagnostics,
    moduleMetadata: result.moduleMetadata,
    metadataDependencies: result.metadataDependencies,
    unresolvedMetadataRequests: result.unresolvedMetadataRequests,
    metadataIncomplete: result.metadataIncomplete,
    explain: result.explain,
    artifacts: result.artifacts,
    compilerBuildId: result.compilerBuildId,
  }
}

function normalizeLegacyDiagnostic(diagnostic) {
  assert.match(diagnostic.code, /^FICT-[A-Z0-9-]+$/)
  return {
    code: diagnostic.code,
    severity: diagnostic.severity ?? 'warning',
  }
}

function compileLegacyFixture(row, legacy) {
  const warnings = []
  const compilerOptions = {
    ...row.fixture.options,
    emitModuleMetadata: false,
    onWarn: warning => warnings.push(normalizeLegacyDiagnostic(warning)),
  }
  if (compilerOptions.dev === undefined) compilerOptions.dev = false
  const plugins = [
    [
      legacy.transformTypescript,
      {
        isTSX: true,
        allExtensions: true,
        allowDeclareFields: true,
        allowNamespaces: true,
      },
    ],
  ]
  plugins.push([legacy.compiler, compilerOptions])
  try {
    const result = legacy.transformSync(row.fixture.source, {
      filename: legacyAuditFilename,
      configFile: false,
      babelrc: false,
      sourceType: 'module',
      parserOpts: {
        sourceType: 'module',
        plugins: ['typescript', 'jsx', 'decorators'],
        allowReturnOutsideFunction: true,
      },
      plugins,
      generatorOpts: { compact: false },
    })
    assert.equal(typeof result?.code, 'string', `${row.fixture.file}:${row.fixture.line}`)
    return {
      status: 'ok',
      diagnostics: warnings,
      codeSha256: sha256(result.code),
    }
  } catch {
    return {
      status: 'error',
      diagnostics: warnings,
      codeSha256: sha256(''),
    }
  }
}

const observedRustAcceptanceReviewIds = new Set()

function deviationPolicy(id, babelStatus, currentStatus, currentErrorCodes, requestVariant) {
  if (babelStatus === currentStatus) return null
  if (requestVariant === 'strict-guarantee') {
    if (
      babelStatus === 'ok' &&
      currentStatus === 'error' &&
      currentErrorCodes.length > 0 &&
      currentErrorCodes.every(code => code === 'FICT-R006')
    ) {
      return 'strict-reactivity-fail-closed'
    }
    throw new Error(
      `strictGuarantee status mismatch: Babel=${babelStatus}, Rust=${currentStatus}; restore the missing guarantee instead of policying the request`,
    )
  }
  if (babelStatus === 'error' && currentStatus === 'ok') {
    const review = rustAcceptanceReviewsById.get(id)
    if (!review) throw new Error(`Unreviewed Rust acceptance: ${id}`)
    assert.ok(rustAcceptanceReview.policies[review.policy], `${id}: unknown acceptance policy`)
    for (const field of ['owner', 'reason', 'finalPlan', 'removalCondition']) {
      assert.equal(typeof review[field], 'string', `${id}: missing ${field}`)
      assert.notEqual(review[field].trim(), '', `${id}: empty ${field}`)
    }
    observedRustAcceptanceReviewIds.add(id)
    return review.policy
  }
  const codes = currentErrorCodes.join(',')
  if (codes === 'FICT-PLACEMENT-STATE-OWNER') return 'narrow-component-role'
  if (codes === 'FICT-M') return 'structured-hook-return'
  if (
    currentErrorCodes.length > 0 &&
    currentErrorCodes.every(code => code === 'FICT-TS-DECORATOR-STANDARD')
  ) {
    return 'standard-decorator-fail-closed'
  }
  throw new Error(
    `Unreviewed compatibility deviation ${babelStatus}->${currentStatus}: ${codes || 'no errors'}`,
  )
}

const options = parseArguments(process.argv.slice(2))
const legacyCompilerRoot = path.join(options.legacyRoot, 'packages/compiler')
const legacyCompilerSource = path.join(legacyCompilerRoot, 'src')
const legacyCompilerArtifact = path.join(legacyCompilerRoot, 'dist/index.cjs')
assert.equal(statSync(legacyCompilerSource).isDirectory(), true, 'missing legacy compiler source')
assert.equal(statSync(legacyCompilerArtifact).isFile(), true, 'missing legacy compiler artifact')
const legacyCompilerPackage = JSON.parse(
  readFileSync(path.join(legacyCompilerRoot, 'package.json'), 'utf8'),
)
const legacyRootPackage = JSON.parse(
  readFileSync(path.join(options.legacyRoot, 'package.json'), 'utf8'),
)
assert.equal(legacyCompilerPackage.version, '0.28.0', 'legacy compiler package version')
assert.equal(legacyRootPackage.packageManager, 'pnpm@9.1.1', 'legacy package manager')
assert.equal(
  sha256(readFileSync(path.join(options.legacyRoot, 'pnpm-lock.yaml'))),
  legacyLockfileSha256,
  'legacy lockfile digest',
)
assert.equal(
  sourceTreeSha256(legacyCompilerSource),
  legacyCompilerSourceSha256,
  'legacy compiler source digest',
)
assert.equal(
  sha256(readFileSync(legacyCompilerArtifact)),
  legacyCompilerArtifactSha256,
  'legacy compiler artifact digest',
)
const legacyRequire = createRequire(path.join(legacyCompilerRoot, 'package.json'))
for (const [name, version] of Object.entries(legacyDependencyVersions)) {
  assert.equal(legacyRequire(`${name}/package.json`).version, version, `${name} version`)
}
const legacyCompilerModule = legacyRequire(legacyCompilerArtifact)
const legacyBabel = legacyRequire('@babel/core')
const legacy = {
  compiler: legacyCompilerModule.default ?? legacyCompilerModule,
  transformSync: legacyBabel.transformSync,
  transformTypescript: legacyRequire('@babel/plugin-transform-typescript'),
}
const inputText = readFileSync(options.input, 'utf8')
assert.equal(sha256(inputText), expectedAuditSha256, 'unexpected batch differential input')
const audit = JSON.parse(inputText)
assert.equal(audit.summary.extracted, expectedExtraction.extracted)
assert.equal(audit.summary.unique, expectedExtraction.unique)
assert.equal(audit.results.length, expectedExtraction.unique)
const requestPolicyText = readFileSync(requestPolicyPath, 'utf8')
const requestPolicy = buildCorpusRequestPolicy({
  audit,
  legacyRoot: options.legacyRoot,
  babel: legacyBabel,
  traverse: legacyBabel.traverse,
})
assert.deepEqual(
  requestPolicy,
  JSON.parse(requestPolicyText),
  'legacy request policy drift; regenerate and review compiler_corpus_request_policy.json',
)
const strictVariants = new Map(requestPolicy.variants.map(variant => [variant.baseId, variant]))

const binding = require(options.nativePath)
const compilerInfo = binding.nativeCompilerInfo()
const policyCounts = Object.fromEntries(Object.keys(deviationPolicies).map(policy => [policy, 0]))
const diagnosticReviewFixtures = []
const filesWithAuditRows = new Set()
const uniqueInputs = new Set()

function compileCorpusFixture(row, { compilerOptions, id, requestVariant, verifyAudit }) {
  const { callee, file, line, source } = row.fixture
  const inputIdentity = JSON.stringify([source, compilerOptions])
  assert.equal(uniqueInputs.has(inputIdentity), false, `${id} duplicates a corpus input`)
  uniqueInputs.add(inputIdentity)

  const request = {
    code: source,
    filename: '/fixtures/legacy-0.28-corpus.tsx',
    options: compilerOptions,
  }
  const first = binding.transformSync(request)
  const second = binding.transformSync(request)
  assert.equal(
    JSON.stringify(deterministicResult(second)),
    JSON.stringify(deterministicResult(first)),
    `${id} is nondeterministic`,
  )

  const status = resultStatus(first.diagnostics)
  const babelAudit = compileLegacyFixture(
    { ...row, fixture: { ...row.fixture, options: compilerOptions } },
    legacy,
  )
  if (verifyAudit) {
    assert.deepEqual(
      {
        status: babelAudit.status,
        diagnosticCodes: babelAudit.diagnostics.map(diagnostic => diagnostic.code),
        codeSha256: babelAudit.codeSha256,
      },
      {
        status: row.legacy.status,
        diagnosticCodes: row.legacy.diagnostics.map(diagnostic => diagnostic.code),
        codeSha256: row.legacy.codeHash ?? null,
      },
      `${id} exact Babel 0.28 audit drift`,
    )
  }
  const errorCodes = first.diagnostics
    .filter(diagnostic => diagnostic.severity === 'error')
    .map(diagnostic => diagnostic.code)
  const policy = deviationPolicy(id, babelAudit.status, status, errorCodes, requestVariant)
  if (policy) policyCounts[policy]++
  const currentDiagnostics = expectedDiagnostics(first.diagnostics)
  diagnosticReviewFixtures.push({
    id,
    babelStatus: babelAudit.status,
    rustStatus: status,
    babelDiagnostics: babelAudit.diagnostics,
    rustDiagnostics: currentDiagnostics,
  })

  return {
    id,
    origin: { file, line, callee, requestVariant },
    source,
    options: compilerOptions,
    babelAudit: {
      status: babelAudit.status,
      diagnosticCodes: babelAudit.diagnostics.map(diagnostic => diagnostic.code),
      codeSha256: babelAudit.codeSha256,
    },
    expected: {
      status,
      diagnostics: currentDiagnostics,
      codeSha256: sha256(first.code),
    },
    deviationPolicy: policy,
  }
}

const fixtures = audit.results.flatMap(row => {
  const { callee, file, line, options: compilerOptions } = row.fixture
  const baseId = `${file}:${line}:${callee}`
  filesWithAuditRows.add(file)
  const fixturesForCall = [
    compileCorpusFixture(row, {
      compilerOptions,
      id: baseId,
      requestVariant: 'audit-baseline',
      verifyAudit: true,
    }),
  ]
  const strictVariant = strictVariants.get(baseId)
  if (strictVariant) {
    fixturesForCall.push(
      compileCorpusFixture(row, {
        compilerOptions: { ...compilerOptions, strictGuarantee: true },
        id: strictVariant.id,
        requestVariant: 'strict-guarantee',
        verifyAudit: false,
      }),
    )
  }
  return fixturesForCall
})

assert.equal(filesWithAuditRows.size, 73)
assert.deepEqual(
  [...observedRustAcceptanceReviewIds].sort(),
  [...rustAcceptanceReviewsById.keys()].sort(),
  'Rust acceptance review contains stale or missing fixtures',
)
assert.deepEqual(policyCounts, expectedPolicyCounts)
const diagnosticReview = buildDiagnosticDeviationReview({
  sourceAuditSha256: expectedAuditSha256,
  fixtures: diagnosticReviewFixtures,
})
if (options.diagnosticReviewOutput) {
  writeFileSync(
    options.diagnosticReviewOutput,
    await format(JSON.stringify(diagnosticReview, null, 2), {
      ...(await resolveConfig(diagnosticReviewPath)),
      filepath: diagnosticReviewPath,
      parser: 'json',
    }),
  )
}
assert.deepEqual(
  diagnosticReview,
  JSON.parse(readFileSync(diagnosticReviewPath, 'utf8')),
  `unreviewed diagnostic deviation; inspect a candidate with --diagnostic-review-output ${diagnosticReviewPath}.candidate`,
)
const reviewedRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
}).trim()
const corpus = {
  schemaVersion: 5,
  provenance: {
    sourceSuiteRelease: '0.28.0',
    sourceSuiteRevision: legacyRevision,
    babelAuditRelease: '0.28.0',
    babelAuditRevision: legacyRevision,
    babelCompilerSourceSha256: legacyCompilerSourceSha256,
    babelCompilerArtifactSha256: legacyCompilerArtifactSha256,
    babelLockfileSha256: legacyLockfileSha256,
    babelAuditFilename: legacyAuditFilename,
    babelPackageManager: legacyRootPackage.packageManager,
    babelDependencies: legacyDependencyVersions,
    rustAuditRelease: '0.31.0',
    rustAuditRevision: reviewedRevision,
    auditInputSha256: expectedAuditSha256,
    requestPolicySha256: sha256(requestPolicyText),
    legacyTestSourceSha256: requestPolicy.legacyTestSourceSha256,
    extractedCalls: expectedExtraction.extracted,
    uniqueFixtures: expectedExtraction.unique,
    strictGuaranteeTrueVariants: requestPolicy.strictTrueVariants,
    corpusFixtures: fixtures.length,
    scannedLegacyTestFiles: 107,
    legacyTestFilesWithAuditRows: filesWithAuditRows.size,
    reviewedRevision,
    reviewedCompilerBuildId: compilerInfo.compilerBuildId,
  },
  deviationPolicies,
  deviationPolicyCounts: policyCounts,
  fixtures,
}

writeFileSync(
  options.output,
  await format(JSON.stringify(corpus, null, 2), {
    ...(await resolveConfig(corpusFormatPath)),
    filepath: corpusFormatPath,
    parser: 'json',
  }),
)
process.stdout.write(
  `${JSON.stringify({ output: options.output, fixtures: fixtures.length, filesWithAuditRows: filesWithAuditRows.size, policyCounts })}\n`,
)
