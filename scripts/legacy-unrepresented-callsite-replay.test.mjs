import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const repositoryRoot = path.resolve(import.meta.dirname, '..')
const replayPath = path.join(
  repositoryRoot,
  'crates/fict-compiler/tests/legacy_unrepresented_callsite_replay.json',
)
const replayText = readFileSync(replayPath, 'utf8')
const replay = JSON.parse(replayText)
const packageJson = JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'))
const rustCodegenCorpus = JSON.parse(
  readFileSync(
    path.join(repositoryRoot, 'crates/fict-compiler/tests/rust_frozen_codegen_corpus.json'),
    'utf8',
  ),
)
const rustDeviationPolicies = new Map(
  rustCodegenCorpus.fixtures
    .filter(fixture => fixture.deviationPolicy)
    .map(fixture => [fixture.id, fixture.deviationPolicy]),
)
const sha256Pattern = /^[0-9a-f]{64}$/
const transitionPolicies = new Map([
  ['legacy-unrepresented-0c0dd70cc25cf882e0de', 'genuine-capability-expansion'],
  ['legacy-unrepresented-13c07ffbbeeb71e71bea', 'strict-reactivity-fail-closed'],
  ['legacy-unrepresented-2fc407522ca3e0b64240', 'strict-reactivity-fail-closed'],
  ['legacy-unrepresented-89ad8d469c7325eab972', 'structured-hook-return'],
  ['legacy-unrepresented-d6ea61baf1cd3c5034bf', 'intentional-runtime-error'],
])
const zeroInvocationPolicies = new Map([
  ['packages/compiler/test/spec-advanced.test.ts:23:18:transform', 'unused-helper-body'],
  [
    'packages/compiler/test/transform.test.ts:807:18:transform',
    'babel-parser-rejection-before-plugin',
  ],
])

test('the unrepresented legacy callsite replay is complete and policy reviewed', () => {
  assert.match(
    packageJson.scripts['test:compiler:compatibility-corpus'],
    /legacy-unrepresented-callsite-replay\.test\.mjs/,
  )
  assert.match(
    packageJson.scripts['test:compiler:compatibility-corpus'],
    /--features preview --test legacy_unrepresented_callsite_replay/,
  )
  assert.match(
    packageJson.scripts['guardrails:rust-crates'],
    /legacy-unrepresented-callsite-replay\.test\.mjs/,
  )
  assert.equal(replay.schemaVersion, 1)
  assert.deepEqual(Object.keys(replay).sort(), [
    'callsites',
    'claimBoundary',
    'fixtures',
    'provenance',
    'schemaVersion',
    'selectedFiles',
    'transitionCounts',
  ])
  assert.deepEqual(replay.claimBoundary, {
    unit: 'runtime-compiler-invocation-associated-with-static-callsite',
    legacyAssertionsExecuted: true,
    legacyGeneratedOutputCompared: false,
    semanticAssertionParityProven: false,
    hostCallbacksCrossNativeBoundary: false,
    ephemeralFileUrlsNormalized: true,
    statusTransitionsPolicyReviewed: true,
    description: replay.claimBoundary.description,
  })
  assert.match(replay.claimBoundary.description, /selected legacy tests execute unchanged/)
  assert.match(replay.claimBoundary.description, /explicit missing metadata snapshots/)
  assert.doesNotMatch(replayText, /file:\/\/\/(?:private\/)?var\/folders\//)
  assert.doesNotMatch(replayText, /file:\/\/\/tmp\//)
  assert.doesNotMatch(replayText, /\/fict-legacy-unrepresented-[^"\s]*\/fict-0\.28\.0\//)

  assert.equal(replay.provenance.sourceSuiteRelease, '0.28.0')
  assert.equal(replay.provenance.sourceSuiteRevision, 'b99ff5b185e3eed701e2d4f3521832dac67c979f')
  for (const field of [
    'legacyCompilerSourceSha256',
    'legacyCompilerIndexSha256',
    'legacyLockfileSha256',
    'legacyTestSourceSha256',
    'assertionInventorySha256',
    'rustCodegenCorpusSha256',
    'generatorSha256',
    'captureConfigSha256',
  ]) {
    assert.match(replay.provenance[field], sha256Pattern, field)
  }
  assert.equal(replay.provenance.selectedTestFiles, 29)
  assert.equal(replay.provenance.selectedTests, 1917)
  assert.equal(replay.provenance.capturedCompilerInvocations, 2327)
  assert.equal(replay.provenance.staticCallsites, 214)
  assert.equal(replay.provenance.executedCallsites, 212)
  assert.equal(replay.provenance.zeroInvocationCallsites, 2)
  assert.equal(replay.provenance.matchedCallsiteExecutions, 1444)
  assert.equal(replay.provenance.replayFixtures, 1222)
  assert.match(replay.provenance.reviewedRevision, /^[0-9a-f]{40}$/)
  assert.match(
    replay.provenance.reviewedCompilerBuildId,
    /^fict-rust-p1-oxc0\.139\.0-m1-[0-9a-f]{64}$/,
  )
  assert.equal(replay.selectedFiles.length, 29)
  assert.deepEqual([...replay.selectedFiles].sort(), replay.selectedFiles)

  assert.equal(replay.callsites.length, 214)
  assert.equal(new Set(replay.callsites.map(callsite => callsite.id)).size, 214)
  assert.equal(replay.callsites.filter(callsite => callsite.runtimeInvocations > 0).length, 212)
  assert.equal(
    replay.callsites.reduce((sum, callsite) => sum + callsite.runtimeInvocations, 0),
    1444,
  )
  const reviewedZeroInvocations = new Map(
    replay.callsites
      .filter(callsite => callsite.runtimeInvocations === 0)
      .map(callsite => {
        assert.deepEqual(callsite.variants, [], callsite.id)
        assert.ok(callsite.zeroInvocationReview?.evidence, callsite.id)
        return [callsite.id, callsite.zeroInvocationReview.disposition]
      }),
  )
  assert.deepEqual(reviewedZeroInvocations, zeroInvocationPolicies)

  assert.equal(replay.fixtures.length, 1222)
  const fixtureIds = new Set(replay.fixtures.map(fixture => fixture.id))
  assert.equal(fixtureIds.size, 1222)
  const referencedFixtureIds = new Set()
  const callsiteVariants = new Map()
  for (const callsite of replay.callsites) {
    assert.equal(
      callsite.variants.reduce((sum, variant) => sum + variant.executions, 0),
      callsite.runtimeInvocations,
      callsite.id,
    )
    const variants = new Set()
    for (const variant of callsite.variants) {
      assert.equal(fixtureIds.has(variant.fixtureId), true, callsite.id)
      assert.ok(variant.executions > 0, callsite.id)
      assert.equal(variants.has(variant.fixtureId), false, callsite.id)
      variants.add(variant.fixtureId)
      referencedFixtureIds.add(variant.fixtureId)
    }
    callsiteVariants.set(callsite.id, variants)
  }
  assert.deepEqual(referencedFixtureIds, fixtureIds)

  const observedTransitions = new Map()
  let missingMetadataInputs = 0
  for (const fixture of replay.fixtures) {
    assert.match(fixture.id, /^legacy-unrepresented-[0-9a-f]{20}$/)
    assert.ok(fixture.origins.length > 0, fixture.id)
    assert.deepEqual([...fixture.origins].sort(), fixture.origins, fixture.id)
    for (const origin of fixture.origins) {
      assert.equal(callsiteVariants.get(origin)?.has(fixture.id), true, `${fixture.id}: ${origin}`)
    }
    assert.match(fixture.request.filename, /^\/fixtures\/legacy-unrepresented\/[0-9a-f]{16}\//)
    assert.match(fixture.expected.codeSha256, sha256Pattern, fixture.id)
    assert.match(fixture.expected.deterministicResultSha256, sha256Pattern, fixture.id)
    const expectedTransition =
      fixture.legacy.status === fixture.expected.status
        ? null
        : `${fixture.legacy.status}-to-${fixture.expected.status}`
    assert.equal(fixture.statusTransition, expectedTransition, fixture.id)
    if (expectedTransition) {
      assert.equal(fixture.transitionPolicy?.releaseDisposition, 'allow', fixture.id)
      assert.equal(fixture.transitionPolicy?.policy, transitionPolicies.get(fixture.id), fixture.id)
      assert.equal(
        rustDeviationPolicies.get(fixture.transitionPolicy.reviewReference),
        fixture.transitionPolicy.policy,
        fixture.id,
      )
      assert.ok(fixture.transitionPolicy.evidence, fixture.id)
      assert.ok(fixture.transitionPolicy.reviewReference, fixture.id)
      observedTransitions.set(fixture.id, fixture.transitionPolicy.policy)
    } else {
      assert.equal(fixture.transitionPolicy, null, fixture.id)
      assert.equal(transitionPolicies.has(fixture.id), false, fixture.id)
    }
    for (const metadata of fixture.request.metadata ?? []) {
      if (metadata.status !== 'missing') continue
      missingMetadataInputs += 1
      assert.equal(metadata.resolvedId, null, fixture.id)
      assert.equal(metadata.metadata, null, fixture.id)
      assert.match(metadata.fingerprint, /^missing:[0-9a-f]{64}$/, fixture.id)
    }
  }
  assert.equal(missingMetadataInputs, 44)
  assert.deepEqual(observedTransitions, transitionPolicies)
  assert.deepEqual(replay.transitionCounts, { 'ok-to-error': 3, 'error-to-ok': 2 })
})
