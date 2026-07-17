import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const repositoryRoot = path.resolve(import.meta.dirname, '..')
const read = relative => readFileSync(path.join(repositoryRoot, relative), 'utf8')
const readJson = relative => JSON.parse(read(relative))
const sha256Pattern = /^[0-9a-f]{64}$/
const revisionPattern = /^[0-9a-f]{40}$/
const compileCorpusPath = 'crates/fict-compiler/tests/legacy_0_28_compile_corpus.json'

test('retains the complete frozen 0.28 compile corpus and reviewed deviations', () => {
  const corpus = readJson(compileCorpusPath)
  assert.equal(corpus.schemaVersion, 1)
  assert.deepEqual(
    {
      legacyRelease: corpus.provenance.legacyRelease,
      legacyRevision: corpus.provenance.legacyRevision,
      rustAuditRelease: corpus.provenance.rustAuditRelease,
      rustAuditRevision: corpus.provenance.rustAuditRevision,
      auditInputSha256: corpus.provenance.auditInputSha256,
      extractedCalls: corpus.provenance.extractedCalls,
      uniqueFixtures: corpus.provenance.uniqueFixtures,
      scannedLegacyTestFiles: corpus.provenance.scannedLegacyTestFiles,
      representedLegacyTestFiles: corpus.provenance.representedLegacyTestFiles,
    },
    {
      legacyRelease: '0.28.0',
      legacyRevision: 'b99ff5b185e3eed701e2d4f3521832dac67c979f',
      rustAuditRelease: '0.30.1',
      rustAuditRevision: '8d4008929d46fc5f2c1e578423ff38ef95a5d084',
      auditInputSha256: '676b022516c01b525d7e2a316e5b072eae2ee1532b2bb103573543900f13b67f',
      extractedCalls: 1974,
      uniqueFixtures: 1892,
      scannedLegacyTestFiles: 107,
      representedLegacyTestFiles: 73,
    },
  )
  assert.match(corpus.provenance.reviewedRevision, revisionPattern)
  assert.match(
    corpus.provenance.reviewedCompilerBuildId,
    /^fict-rust-p1-oxc0\.139\.0-m1-[0-9a-f]{64}$/,
  )
  assert.equal(corpus.fixtures.length, 1892)

  const ids = new Set()
  const inputs = new Set()
  const representedFiles = new Set()
  const policyCounts = Object.fromEntries(
    Object.keys(corpus.deviationPolicies).map(policy => [policy, 0]),
  )
  for (const fixture of corpus.fixtures) {
    assert.equal(
      fixture.id,
      `${fixture.origin.file}:${fixture.origin.line}:${fixture.origin.callee}`,
    )
    assert.equal(ids.has(fixture.id), false, fixture.id)
    ids.add(fixture.id)
    assert.match(fixture.origin.file, /^packages\/compiler\/test\/.*\.test\.ts$/)
    representedFiles.add(fixture.origin.file)
    const input = JSON.stringify([fixture.source, fixture.options])
    assert.equal(inputs.has(input), false, fixture.id)
    inputs.add(input)
    assert.ok(fixture.source.trim(), fixture.id)
    assert.ok(['ok', 'error'].includes(fixture.legacy.status), fixture.id)
    assert.ok(['ok', 'error'].includes(fixture.expected.status), fixture.id)
    assert.ok(
      fixture.legacy.diagnosticCodes.every(code => /^FICT-[A-Z0-9-]+$/.test(code)),
      fixture.id,
    )
    if (fixture.legacy.codeSha256 !== null) {
      assert.match(fixture.legacy.codeSha256, sha256Pattern, fixture.id)
    }
    assert.match(fixture.expected.codeSha256, sha256Pattern, fixture.id)
    assert.ok(
      fixture.expected.diagnostics.every(
        diagnostic =>
          /^FICT-[A-Z0-9-]+$/.test(diagnostic.code) &&
          ['error', 'warning', 'info'].includes(diagnostic.severity) &&
          ['notApplicable', 'advisory', 'fallback', 'unsupported', 'internal'].includes(
            diagnostic.guaranteeClass,
          ),
      ),
      fixture.id,
    )
    assert.equal(
      fixture.expected.status,
      fixture.expected.diagnostics.some(diagnostic => diagnostic.severity === 'error')
        ? 'error'
        : 'ok',
      fixture.id,
    )
    const statusChanged = fixture.legacy.status !== fixture.expected.status
    assert.equal(fixture.deviationPolicy !== null, statusChanged, fixture.id)
    if (fixture.deviationPolicy !== null) {
      assert.ok(corpus.deviationPolicies[fixture.deviationPolicy], fixture.id)
      policyCounts[fixture.deviationPolicy]++
    }
  }

  assert.equal(ids.size, 1892)
  assert.equal(inputs.size, 1892)
  assert.equal(representedFiles.size, 73)
  assert.deepEqual(policyCounts, corpus.deviationPolicyCounts)
  assert.deepEqual(corpus.deviationPolicyCounts, {
    'rust-capability-expansion': 22,
    'reserved-option-rejected': 37,
    'narrow-component-role': 24,
    'structured-hook-return': 6,
    'namespace-macro-fail-closed': 1,
  })
})

test('retains normalized frontend and analysis compatibility oracles', () => {
  const frontend = readJson('crates/fict-compiler-oxc/tests/frontend_compatibility.json')
  const analysis = readJson('crates/fict-compiler/tests/analysis_compatibility.json')
  assert.equal(frontend.length, 13)
  assert.equal(frontend.filter(fixture => fixture.accepted).length, 6)
  assert.equal(frontend.filter(fixture => !fixture.accepted).length, 7)
  assert.ok(
    frontend
      .filter(fixture => !fixture.accepted)
      .every(fixture => fixture.legacyMessage && /^FICT-/.test(fixture.rustCode)),
  )
  assert.equal(analysis.length, 7)
  assert.deepEqual(
    analysis
      .filter(fixture => fixture.deviationPolicy)
      .map(fixture => [fixture.name, fixture.deviationPolicy]),
    [['closed object shape and property mutation', 'narrow-component-role']],
  )
  assert.ok(analysis.every(fixture => fixture.expected))

  const frontendTest = read('crates/fict-compiler-oxc/tests/frontend_compatibility.rs')
  const analysisTest = read('crates/fict-compiler/tests/analysis_compatibility.rs')
  const compileTest = read('crates/fict-compiler/tests/compatibility_corpus.rs')
  assert.match(frontendTest, /include_str!\("frontend_compatibility\.json"\)/)
  assert.match(analysisTest, /include_str!\("analysis_compatibility\.json"\)/)
  assert.match(compileTest, /include_str!\(\s*"legacy_0_28_compile_corpus\.json"\s*\)/)
  assert.match(compileTest, /without_a_legacy_backend/)
})

test('retains native runtime and option compatibility outcomes', () => {
  const runtime = read('scripts/native-compiler-runtime.test.mjs')
  for (const name of [
    'Rust compiler output preserves Core reactive runtime behavior',
    'captured reactive aliases remain mutable after an event',
    'projected reactive mutations preserve JavaScript evaluation semantics',
    'reactive conditional returns preserve branch statements and local scope',
    'named function expression hooks use their public binding role',
    'runtime reactive creators preserve calls and enforce configurable R004',
    'derived cycles fail closed even when strict guarantees are disabled',
    'reserved compiler macros fail closed without direct Fict imports',
    'same-module hook metadata protects structured reactive members',
    'semantic EmitIR identities preserve destructuring and authored export names',
    'intrinsic children props become child content without leaking attributes',
    'raw-text and RCDATA expressions bind literal textContent',
    'dynamic annotation-xml children use the final live encoding namespace',
    'native binding rejects unimplemented non-default compiler options',
  ]) {
    assert.ok(runtime.includes(`test('${name}'`), name)
  }
})

test('keeps corpus regeneration bound to the audited input digest', () => {
  const generator = read('scripts/generate-compiler-compatibility-corpus.mjs')
  assert.match(generator, /676b022516c01b525d7e2a316e5b072eae2ee1532b2bb103573543900f13b67f/)
  assert.match(generator, /Unreviewed compatibility deviation/)
  assert.doesNotMatch(generator, /@babel\/|compiler\/legacy/)
})
