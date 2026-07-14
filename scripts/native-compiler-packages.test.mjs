import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  NATIVE_COMPILER_NODE_LANES,
  NATIVE_COMPILER_TARGETS,
  assembleNativePackage,
  bundleNativePackage,
  nativeArtifactName,
  nativeBuildMatrix,
  nativeRuntimeMatrix,
  validateNativePackageConfiguration,
  verifyNativeBundle,
  verifyNativePackageArtifact,
} from './native-compiler-packages.mjs'
import {
  collectNativePublishActions,
  validateNativePublishPlan,
} from './publish-native-compiler-packages.mjs'
import { prepareReleaseArtifacts, validateReleasePublishPlan } from './publish-release-packages.mjs'

test('defines eight blocking native targets and two Node runtime lanes', () => {
  assert.equal(NATIVE_COMPILER_TARGETS.length, 8)
  assert.deepEqual(NATIVE_COMPILER_NODE_LANES, ['22.18.0', '24'])
  assert.equal(nativeBuildMatrix().include.length, 8)
  assert.equal(nativeRuntimeMatrix().include.length, 16)

  const runtimePairs = new Set(
    nativeRuntimeMatrix().include.map(entry => `${entry.target}:${entry.node}`),
  )
  for (const target of NATIVE_COMPILER_TARGETS) {
    for (const node of NATIVE_COMPILER_NODE_LANES) {
      assert.ok(runtimePairs.has(`${target.target}:${node}`))
    }
  }
})

test('keeps facade optional dependencies, package manifests, allowlist, and Changesets aligned', () => {
  assert.deepEqual(validateNativePackageConfiguration(), [])
})

test('assembles and verifies deterministic binary metadata and checksums', () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'fict-native-package-test-'))
  try {
    const binaryPath = path.join(tempRoot, 'compiler.node')
    const packageDirectory = path.join(tempRoot, 'package')
    writeFileSync(binaryPath, 'native-test-binary')
    assembleNativePackage({
      target: 'darwin-arm64',
      binaryPath,
      outputDirectory: packageDirectory,
    })
    const artifact = verifyNativePackageArtifact({
      target: 'darwin-arm64',
      packageDirectory,
    })
    assert.equal(artifact.bindingManifest.rustTarget, 'aarch64-apple-darwin')
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/)

    writeFileSync(artifact.binaryPath, 'tampered')
    assert.throws(
      () => verifyNativePackageArtifact({ target: 'darwin-arm64', packageDirectory }),
      /binding-manifest\.json does not match/,
    )
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('packs a complete native bundle with a tarball checksum', () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'fict-native-bundle-test-'))
  try {
    const binaryPath = path.join(tempRoot, 'compiler.node')
    const bundleDirectory = path.join(tempRoot, 'bundle')
    writeFileSync(binaryPath, 'native-test-binary')
    const evidence = bundleNativePackage({
      target: 'darwin-arm64',
      binaryPath,
      outputDirectory: bundleDirectory,
    })
    const verified = verifyNativeBundle({ target: 'darwin-arm64', bundleDirectory })
    assert.equal(evidence.tarballSha256, verified.tarballSha256)
    assert.match(
      readFileSync(`${verified.tarballPath}.sha256`, 'utf8'),
      new RegExp(`^${verified.tarballSha256}  `),
    )
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('refuses a partial or facade-first native publication', () => {
  const packages = [
    { name: '@fictjs/compiler', version: '1.2.3', status: 'pending' },
    ...NATIVE_COMPILER_TARGETS.map(target => ({
      name: target.packageName,
      version: '1.2.3',
      status: 'pending',
    })),
  ]
  const valid = {
    packages,
    publishOrder: [
      ...NATIVE_COMPILER_TARGETS.map(target => target.packageName),
      '@fictjs/compiler',
    ],
  }
  assert.deepEqual(validateNativePublishPlan(valid), [])
  assert.equal(collectNativePublishActions(valid).length, 8)

  const facadeFirst = {
    ...valid,
    publishOrder: ['@fictjs/compiler', ...valid.publishOrder.slice(0, -1)],
  }
  assert.equal(validateNativePublishPlan(facadeFirst).length, 8)

  const partial = structuredClone(valid)
  partial.packages[0].status = 'already-published'
  assert.equal(validateNativePublishPlan(partial).length, 8)
})

test('requires dependency-topological publication after the native packages', () => {
  const packages = [
    { name: '@fictjs/compiler', version: '1.2.3', status: 'pending' },
    { name: '@fictjs/plugin', version: '1.2.3', status: 'pending' },
    ...NATIVE_COMPILER_TARGETS.map(target => ({
      name: target.packageName,
      version: '1.2.3',
      status: 'pending',
    })),
  ]
  const nativeNames = NATIVE_COMPILER_TARGETS.map(target => target.packageName)
  const manifests = new Map([
    ...nativeNames.map(name => [name, {}]),
    [
      '@fictjs/compiler',
      { optionalDependencies: Object.fromEntries(nativeNames.map(name => [name, '1.2.3'])) },
    ],
    ['@fictjs/plugin', { dependencies: { '@fictjs/compiler': '1.2.3' } }],
  ])
  const valid = {
    packages,
    publishOrder: [...nativeNames, '@fictjs/compiler', '@fictjs/plugin'],
  }
  assert.deepEqual(validateReleasePublishPlan(valid, manifests), [])

  const invalid = {
    ...valid,
    publishOrder: [...nativeNames, '@fictjs/plugin', '@fictjs/compiler'],
  }
  assert.deepEqual(validateReleasePublishPlan(invalid, manifests), [
    '@fictjs/compiler must publish before dependent @fictjs/plugin',
  ])
})

test('preflights all eight native bundles before creating release artifacts', () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'fict-native-release-test-'))
  try {
    const nativeArtifactsRoot = path.join(tempRoot, 'native-artifacts')
    const version = JSON.parse(
      readFileSync(new URL('../packages/compiler/package.json', import.meta.url), 'utf8'),
    ).version
    for (const target of NATIVE_COMPILER_TARGETS) {
      const binaryPath = path.join(tempRoot, `${target.target}.node`)
      writeFileSync(binaryPath, `native-test-binary:${target.target}`)
      bundleNativePackage({
        target: target.target,
        binaryPath,
        outputDirectory: path.join(nativeArtifactsRoot, nativeArtifactName(target.target)),
      })
    }

    const nativeEntries = NATIVE_COMPILER_TARGETS.map(target => ({
      name: target.packageName,
      path: target.packageDirectory,
      version,
      status: 'already-published',
    }))
    const plan = {
      registry: 'https://registry.npmjs.org',
      packages: [
        {
          name: '@fictjs/compiler',
          path: 'packages/compiler',
          version,
          status: 'already-published',
        },
        ...nativeEntries,
      ],
      publishOrder: [...nativeEntries.map(entry => entry.name), '@fictjs/compiler'],
    }
    const prepared = prepareReleaseArtifacts({
      plan,
      nativeArtifactsRoot,
      outputDirectory: path.join(tempRoot, 'release'),
    })
    assert.equal(prepared.artifacts.length, 9)
    assert.ok(prepared.artifacts.every(artifact => artifact.tarball === null))
    assert.match(prepared.planFingerprint, /^[0-9a-f]{64}$/)
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
