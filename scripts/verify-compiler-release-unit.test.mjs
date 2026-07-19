import assert from 'node:assert/strict'
import test from 'node:test'

import { validateCompilerReleaseUnit } from './verify-compiler-release-unit.mjs'

const version = '1.2.3'
const revision = 'a'.repeat(40)
const capabilityIdentity = {
  version: 1,
  digest: `sha256:${'b'.repeat(64)}`,
  packageVersion: version,
}
const corpusIdentity = {
  schemaVersion: 1,
  corpusSchemaVersion: 5,
  corpusSha256: `sha256:${'c'.repeat(64)}`,
  fixtures: 1_950,
  reviewedRevision: 'd'.repeat(40),
  reviewedCompilerBuildId: 'reviewed-build',
}

function fixture() {
  return {
    plan: {
      tag: `v${version}`,
      packages: [{ name: '@fictjs/compiler', version }],
    },
    certification: {
      schemaVersion: 3,
      packageVersion: version,
      compilerBuildRevision: revision,
      compilerCapabilityManifestVersion: capabilityIdentity.version,
      compilerCapabilityManifestDigest: capabilityIdentity.digest,
      compilerCapabilityPackageVersion: capabilityIdentity.packageVersion,
      compatibilityCorpus: structuredClone(corpusIdentity),
    },
    revision,
    tagRevision: revision,
    corpusIdentity,
    capabilityIdentity,
    reviewedRevisionIsAncestor: true,
  }
}

test('accepts one version, tag, revision, capability, certification, and corpus unit', () => {
  assert.deepEqual(validateCompilerReleaseUnit(fixture()), [])
})

test('rejects every independently drifting release identity', () => {
  const cases = [
    ['tag', value => (value.plan.tag = 'v1.2.2'), /release plan tag/],
    ['tag revision', value => (value.tagRevision = 'e'.repeat(40)), /tag revision/],
    [
      'certification version',
      value => (value.certification.packageVersion = '1.2.2'),
      /certification package version/,
    ],
    [
      'capability digest',
      value => (value.certification.compilerCapabilityManifestDigest = `sha256:${'f'.repeat(64)}`),
      /capability manifest/,
    ],
    [
      'corpus',
      value => (value.certification.compatibilityCorpus.corpusSha256 = `sha256:${'1'.repeat(64)}`),
      /exact frozen compiler corpus/,
    ],
    [
      'review ancestry',
      value => (value.reviewedRevisionIsAncestor = false),
      /reviewed revision is not an ancestor/,
    ],
  ]
  for (const [name, mutate, expected] of cases) {
    const value = fixture()
    mutate(value)
    assert.match(validateCompilerReleaseUnit(value).join('\n'), expected, name)
  }
})
