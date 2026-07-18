#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const repositoryRoot = path.resolve(import.meta.dirname, '..')
const expectedAuditSha256 = '676b022516c01b525d7e2a316e5b072eae2ee1532b2bb103573543900f13b67f'
const expectedSummary = {
  extracted: 1974,
  unique: 1892,
  legacyOkCurrentError: 38,
  legacyErrorCurrentOk: 41,
  bothOk: 1730,
  currentParseErrors: 1,
  currentNondeterministic: 0,
  currentThrows: 0,
}
const deviationPolicies = {
  'rust-capability-expansion':
    'Rust accepts a reviewed TypeScript, control-flow, or analysis case rejected by the audited Babel 0.30.1 legacy backend.',
  'narrow-component-role':
    'Rust requires an explicit component role before component-context macros are legal; indirect or anonymous owners fail closed.',
  'structured-hook-return':
    'Rust 0.31 enforces readonly and setter rules for structured same-module hook return accessors.',
  'namespace-macro-fail-closed':
    'Rust 0.31 rejects compiler macros invoked through a Fict namespace instead of leaving an uncompiled runtime call.',
}
const expectedPolicyCounts = {
  'rust-capability-expansion': 22,
  'narrow-component-role': 24,
  'structured-hook-return': 6,
  'namespace-macro-fail-closed': 1,
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
    name => !['input', 'native-path', 'output'].includes(name),
  )
  if (unknown.length > 0) throw new Error(`Unknown argument(s): ${unknown.join(', ')}`)
  if (!options.input) throw new Error('--input is required')
  return {
    input: path.resolve(options.input),
    nativePath: path.resolve(
      options['native-path'] ?? path.join(repositoryRoot, 'target/release/fict_compiler_napi.node'),
    ),
    output: path.resolve(
      options.output ??
        path.join(repositoryRoot, 'crates/fict-compiler/tests/rust_frozen_codegen_corpus.json'),
    ),
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
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

function deviationPolicy(babelStatus, currentStatus, currentErrorCodes) {
  if (babelStatus === currentStatus) return null
  if (babelStatus === 'error' && currentStatus === 'ok') return 'rust-capability-expansion'
  const codes = currentErrorCodes.join(',')
  if (codes === 'FICT-PLACEMENT-STATE-OWNER') return 'narrow-component-role'
  if (codes === 'FICT-M') return 'structured-hook-return'
  if (codes === 'FICT-HIR-MACRO-NAMESPACE') return 'namespace-macro-fail-closed'
  throw new Error(
    `Unreviewed compatibility deviation ${babelStatus}->${currentStatus}: ${codes || 'no errors'}`,
  )
}

const options = parseArguments(process.argv.slice(2))
const inputText = readFileSync(options.input, 'utf8')
assert.equal(sha256(inputText), expectedAuditSha256, 'unexpected batch differential input')
const audit = JSON.parse(inputText)
assert.deepEqual(audit.summary, expectedSummary)
assert.equal(audit.results.length, expectedSummary.unique)

const binding = require(options.nativePath)
const compilerInfo = binding.nativeCompilerInfo()
const policyCounts = Object.fromEntries(Object.keys(deviationPolicies).map(policy => [policy, 0]))
const representedFiles = new Set()
const uniqueInputs = new Set()

const fixtures = audit.results.map(row => {
  const { callee, file, line, options: compilerOptions, source } = row.fixture
  const inputIdentity = JSON.stringify([source, compilerOptions])
  assert.equal(uniqueInputs.has(inputIdentity), false, `${file}:${line} duplicates a corpus input`)
  uniqueInputs.add(inputIdentity)
  representedFiles.add(file)

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
    `${file}:${line}:${callee} is nondeterministic`,
  )

  const status = resultStatus(first.diagnostics)
  const errorCodes = first.diagnostics
    .filter(diagnostic => diagnostic.severity === 'error')
    .map(diagnostic => diagnostic.code)
  const policy = deviationPolicy(row.legacy.status, status, errorCodes)
  if (policy) policyCounts[policy]++

  return {
    id: `${file}:${line}:${callee}`,
    origin: { file, line, callee },
    source,
    options: compilerOptions,
    babelAudit: {
      status: row.legacy.status,
      diagnosticCodes: row.legacy.diagnostics.map(diagnostic => diagnostic.code),
      codeSha256: row.legacy.codeHash ?? null,
    },
    expected: {
      status,
      diagnostics: expectedDiagnostics(first.diagnostics),
      codeSha256: sha256(first.code),
    },
    deviationPolicy: policy,
  }
})

assert.equal(representedFiles.size, 73)
assert.deepEqual(policyCounts, expectedPolicyCounts)
const reviewedRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
}).trim()
const corpus = {
  schemaVersion: 2,
  provenance: {
    sourceSuiteRelease: '0.28.0',
    sourceSuiteRevision: 'b99ff5b185e3eed701e2d4f3521832dac67c979f',
    babelAuditRelease: '0.30.1',
    babelAuditRevision: '8d4008929d46fc5f2c1e578423ff38ef95a5d084',
    rustAuditRelease: '0.30.1',
    rustAuditRevision: '8d4008929d46fc5f2c1e578423ff38ef95a5d084',
    auditInputSha256: expectedAuditSha256,
    extractedCalls: expectedSummary.extracted,
    uniqueFixtures: expectedSummary.unique,
    scannedLegacyTestFiles: 107,
    representedLegacyTestFiles: representedFiles.size,
    reviewedRevision,
    reviewedCompilerBuildId: compilerInfo.compilerBuildId,
  },
  deviationPolicies,
  deviationPolicyCounts: policyCounts,
  fixtures,
}

writeFileSync(options.output, `${JSON.stringify(corpus, null, 2)}\n`)
process.stdout.write(
  `${JSON.stringify({ output: options.output, fixtures: fixtures.length, representedFiles: representedFiles.size, policyCounts })}\n`,
)
