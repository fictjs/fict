import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
  classifyNativeBootstrapRegistry,
  nativeBootstrapPublishArgs,
  nativeTrustedPublisherArgs,
  validateNativeBootstrapCertification,
} from './bootstrap-native-compiler-packages.mjs'
import { NATIVE_COMPILER_NODE_LANES, NATIVE_COMPILER_TARGETS } from './native-compiler-packages.mjs'

const revision = 'a'.repeat(40)
const packageVersion = '1.2.3'

function fixture() {
  const hashCharacters = '123456789abcdef0'
  const bundles = new Map(
    NATIVE_COMPILER_TARGETS.map((target, index) => {
      const binarySha256 = hashCharacters[index].repeat(64)
      const tarballSha256 = hashCharacters[index + 8].repeat(64)
      const tarballBytes = 1_000 + index
      const unpackedBytes = 2_000 + index
      const sizeGate = {
        schemaVersion: 1,
        target: target.target,
        profile: 'ci',
        tarballBytes,
        unpackedBytes,
        maximumTarballBytes: 10_000,
        maximumUnpackedBytes: 20_000,
        passed: true,
        violations: [],
      }
      return [
        target.target,
        {
          packageManifest: { name: target.packageName, version: packageVersion },
          sha256: binarySha256,
          tarballSha256,
          tarballPath: `/tmp/${target.target}.tgz`,
          buildEvidence: {
            tarballBytes,
            unpackedBytes,
            sizeGate,
            npmIntegrity: `sha512-${target.target}`,
          },
        },
      ]
    }),
  )
  const certifiedPairs = NATIVE_COMPILER_TARGETS.flatMap(target =>
    NATIVE_COMPILER_NODE_LANES.map(nodeLane => `${target.target}:node-${nodeLane}`),
  )
  const payload = {
    schemaVersion: 2,
    status: 'pass',
    targets: 8,
    nodeLanes: [...NATIVE_COMPILER_NODE_LANES],
    certifications: 16,
    bundles: 8,
    certifiedPairs,
    runtimeEvidence: certifiedPairs.map(pair => {
      const [target, nodeLane] = pair.split(':node-')
      return {
        pair,
        target,
        nodeLane,
        node: nodeLane === '22.18.0' ? 'v22.18.0' : 'v24.7.0',
        evidenceDigest: `sha256:${'f'.repeat(64)}`,
      }
    }),
    releaseBundles: NATIVE_COMPILER_TARGETS.map(target => {
      const bundle = bundles.get(target.target)
      return {
        target: target.target,
        packageVersion,
        binarySha256: bundle.sha256,
        tarballSha256: bundle.tarballSha256,
        tarballBytes: bundle.buildEvidence.tarballBytes,
        unpackedBytes: bundle.buildEvidence.unpackedBytes,
        sizeGate: bundle.buildEvidence.sizeGate,
      }
    }),
    packageVersion,
    compilerBuildId: 'fict-rust-test',
    compilerBuildRevision: revision,
  }
  return {
    bundles,
    certification: {
      ...payload,
      certificationDigest: `sha256:${createHash('sha256')
        .update(JSON.stringify(payload))
        .digest('hex')}`,
    },
  }
}

test('binds bootstrap to the complete certified bundle matrix and exact revision', () => {
  const { bundles, certification } = fixture()
  assert.deepEqual(validateNativeBootstrapCertification(certification, bundles, revision), {
    packageVersion,
    compilerBuildId: 'fict-rust-test',
    compilerBuildRevision: revision,
    certificationDigest: certification.certificationDigest,
  })
  assert.throws(
    () => validateNativeBootstrapCertification(certification, bundles, 'b'.repeat(40)),
    /expected compiler build revision/,
  )
  const tampered = structuredClone(certification)
  tampered.releaseBundles[0].tarballBytes += 1
  assert.throws(
    () => validateNativeBootstrapCertification(tampered, bundles, revision),
    /digest does not match|identity does not match/,
  )
})

test('only bootstraps package names after the certified facade version exists', () => {
  const { bundles, certification } = fixture()
  const certified = validateNativeBootstrapCertification(certification, bundles, revision)
  const facadeDocument = { versions: { [packageVersion]: {} } }
  const nativeDocuments = new Map(NATIVE_COMPILER_TARGETS.map(target => [target.packageName, null]))
  const actions = classifyNativeBootstrapRegistry({
    certification: certified,
    bundles,
    facadeDocument,
    nativeDocuments,
  })
  assert.equal(actions.length, 8)
  assert.ok(actions.every(action => action.status === 'new-package'))
  assert.throws(
    () =>
      classifyNativeBootstrapRegistry({
        certification: certified,
        bundles,
        facadeDocument: { versions: {} },
        nativeDocuments,
      }),
    /must already be published/,
  )
})

test('accepts resumable package creation only when published integrity matches', () => {
  const { bundles, certification } = fixture()
  const certified = validateNativeBootstrapCertification(certification, bundles, revision)
  const facadeDocument = { versions: { [packageVersion]: {} } }
  const nativeDocuments = new Map(
    NATIVE_COMPILER_TARGETS.map(target => [
      target.packageName,
      {
        name: target.packageName,
        versions: {
          [packageVersion]: {
            dist: { integrity: bundles.get(target.target).buildEvidence.npmIntegrity },
          },
        },
      },
    ]),
  )
  const actions = classifyNativeBootstrapRegistry({
    certification: certified,
    bundles,
    facadeDocument,
    nativeDocuments,
  })
  assert.ok(actions.every(action => action.status === 'verified'))
  nativeDocuments.get(NATIVE_COMPILER_TARGETS[0].packageName).versions[
    packageVersion
  ].dist.integrity = 'sha512-tampered'
  assert.throws(
    () =>
      classifyNativeBootstrapRegistry({
        certification: certified,
        bundles,
        facadeDocument,
        nativeDocuments,
      }),
    /integrity does not match/,
  )
})

test('uses explicit no-provenance bootstrap and repository-scoped trust commands', () => {
  assert.deepEqual(nativeBootstrapPublishArgs('/tmp/native.tgz'), [
    'publish',
    '/tmp/native.tgz',
    '--access',
    'public',
    '--provenance=false',
  ])
  assert.deepEqual(nativeTrustedPublisherArgs('@fictjs/compiler-darwin-arm64'), [
    'trust',
    'github',
    '@fictjs/compiler-darwin-arm64',
    '--file',
    'release.yml',
    '--repo',
    'fictjs/fict',
    '--allow-publish',
  ])
})
