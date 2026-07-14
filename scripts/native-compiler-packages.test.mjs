import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  packageCommandInvocation,
  relativeFileDependency,
} from './native-compiler-package-smoke.mjs'
import {
  NATIVE_COMPILER_NODE_LANES,
  NATIVE_COMPILER_TARGETS,
  assembleNativePackage,
  bundleNativePackage,
  evaluateNativePackageSize,
  loadNativePackageSizeBudget,
  nativeArtifactName,
  nativeBuildMatrix,
  nativeHostTarget,
  nativeNodeVersionMatchesLane,
  nativeRuntimeMatrix,
  npmInvocation,
  validateNativePackageConfiguration,
  validateNativeRuntimeEvidenceMatrix,
  validateOxcVersionAlignment,
  verifyNativeBundle,
  verifyNativePackageArtifact,
} from './native-compiler-packages.mjs'
import {
  collectNativePublishActions,
  validateNativePublishPlan,
} from './publish-native-compiler-packages.mjs'
import { prepareReleaseArtifacts, validateReleasePublishPlan } from './publish-release-packages.mjs'

const RUNTIME_REVISION = 'a'.repeat(40)
const RUNTIME_BUILD_ID = `fict-rust-p1-oxc0.139.0-m1-${'b'.repeat(64)}`

function nativeRuntimeEvidenceFixture(nativeBundles = new Map()) {
  const hashCharacters = '123456789abcdef0'
  return NATIVE_COMPILER_TARGETS.flatMap((target, targetIndex) => {
    const releaseBundle = nativeBundles.get(target.target)
    const binarySha256 = releaseBundle?.binarySha256 ?? hashCharacters[targetIndex].repeat(64)
    const tarballSha256 = releaseBundle?.tarballSha256 ?? hashCharacters[targetIndex + 8].repeat(64)
    const tarballBytes = releaseBundle?.tarballBytes ?? 1_000 + targetIndex
    const unpackedBytes = releaseBundle?.unpackedBytes ?? 2_000 + targetIndex
    const sizeGate = releaseBundle?.sizeGate ?? {
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
    return NATIVE_COMPILER_NODE_LANES.map(nodeLane => ({
      schemaVersion: 2,
      target: target.target,
      rustTarget: target.rustTarget,
      nodeLane,
      node: nodeLane === '22.18.0' ? 'v22.18.0' : 'v24.7.0',
      platform: target.platform,
      arch: target.arch,
      libc: target.libc,
      packageName: target.packageName,
      packageVersion: releaseBundle?.packageVersion ?? '1.2.3',
      binarySha256,
      tarballSha256,
      tarballBytes,
      unpackedBytes,
      sizeGate: structuredClone(sizeGate),
      compilerBuildId: RUNTIME_BUILD_ID,
      compilerBuildRevision: RUNTIME_REVISION,
      formats: ['esm', 'cjs'],
      syncAndAsync: true,
      rustToolchainRequired: false,
    }))
  })
}

function nativeBundleIdentitiesFixture(documents) {
  return new Map(
    NATIVE_COMPILER_TARGETS.map(target => {
      const evidence = documents.find(candidate => candidate.target === target.target)
      return [
        target.target,
        {
          packageVersion: evidence.packageVersion,
          binarySha256: evidence.binarySha256,
          tarballSha256: evidence.tarballSha256,
          tarballBytes: evidence.tarballBytes,
          unpackedBytes: evidence.unpackedBytes,
          sizeGate: structuredClone(evidence.sizeGate),
        },
      ]
    }),
  )
}

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

  assert.equal(nativeNodeVersionMatchesLane('v22.18.0', '22.18.0'), true)
  assert.equal(nativeNodeVersionMatchesLane('v22.18.1', '22.18.0'), false)
  assert.equal(nativeNodeVersionMatchesLane('v24.7.0', '24'), true)
  assert.equal(nativeNodeVersionMatchesLane('v25.0.0', '24'), false)
})

test('certifies one complete revision-bound native runtime evidence matrix', () => {
  const documents = nativeRuntimeEvidenceFixture()
  const result = validateNativeRuntimeEvidenceMatrix(documents, {
    expectedRevision: RUNTIME_REVISION,
    nativeBundles: nativeBundleIdentitiesFixture(documents),
  })
  assert.deepEqual(
    (({
      schemaVersion,
      status,
      targets,
      nodeLanes,
      certifications,
      bundles,
      packageVersion,
      compilerBuildId,
      compilerBuildRevision,
    }) => ({
      schemaVersion,
      status,
      targets,
      nodeLanes,
      certifications,
      bundles,
      packageVersion,
      compilerBuildId,
      compilerBuildRevision,
    }))(result),
    {
      schemaVersion: 2,
      status: 'pass',
      targets: 8,
      nodeLanes: ['22.18.0', '24'],
      certifications: 16,
      bundles: 8,
      packageVersion: '1.2.3',
      compilerBuildId: RUNTIME_BUILD_ID,
      compilerBuildRevision: RUNTIME_REVISION,
    },
  )
  assert.equal(result.certifiedPairs.length, 16)
  assert.equal(new Set(result.certifiedPairs).size, 16)
  assert.equal(result.runtimeEvidence.length, 16)
  assert.deepEqual(
    result.runtimeEvidence.map(evidence => evidence.pair),
    result.certifiedPairs,
  )
  assert.ok(
    result.runtimeEvidence.every(evidence => /^sha256:[0-9a-f]{64}$/.test(evidence.evidenceDigest)),
  )
  assert.equal(result.releaseBundles.length, 8)
  assert.match(result.certificationDigest, /^sha256:[0-9a-f]{64}$/)
  const { certificationDigest, ...payload } = result
  assert.equal(
    certificationDigest,
    `sha256:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`,
  )
  assert.deepEqual(
    result.releaseBundles.map(bundle => bundle.target),
    NATIVE_COMPILER_TARGETS.map(target => target.target),
  )
})

test('verifies downloaded native runtime evidence through the release CLI', () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'fict-native-evidence-test-'))
  const evidenceDirectory = path.join(tempRoot, 'runtime-evidence')
  const artifactsDirectory = path.join(tempRoot, 'native-artifacts')
  const certificationPath = path.join(tempRoot, 'native-certification.json')
  mkdirSync(evidenceDirectory)
  try {
    const nativeBundles = new Map()
    for (const target of NATIVE_COMPILER_TARGETS) {
      const binaryPath = path.join(tempRoot, `${target.target}.node`)
      writeFileSync(binaryPath, `native-runtime-evidence-test:${target.target}`)
      const bundle = bundleNativePackage({
        target: target.target,
        binaryPath,
        outputDirectory: path.join(artifactsDirectory, nativeArtifactName(target.target)),
      })
      nativeBundles.set(target.target, {
        packageVersion: bundle.packageVersion,
        binarySha256: bundle.binarySha256,
        tarballSha256: bundle.tarballSha256,
        tarballBytes: bundle.tarballBytes,
        unpackedBytes: bundle.unpackedBytes,
        sizeGate: bundle.sizeGate,
      })
    }
    for (const evidence of nativeRuntimeEvidenceFixture(nativeBundles)) {
      writeFileSync(
        path.join(evidenceDirectory, `${evidence.target}-node-${evidence.nodeLane}.json`),
        `${JSON.stringify(evidence)}\n`,
      )
    }
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./native-compiler-packages.mjs', import.meta.url)),
        'verify-runtime-evidence',
        '--evidence',
        evidenceDirectory,
        '--artifacts',
        artifactsDirectory,
        '--revision',
        RUNTIME_REVISION,
        '--output',
        certificationPath,
      ],
      { encoding: 'utf8' },
    )
    assert.equal(result.status, 0, result.stderr)
    const certification = JSON.parse(result.stdout)
    assert.deepEqual(JSON.parse(readFileSync(certificationPath, 'utf8')), certification)
    assert.deepEqual(
      (({ certifications, bundles }) => ({ certifications, bundles }))(certification),
      { certifications: 16, bundles: 8 },
    )
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('rejects incomplete, duplicate, mixed-build, and mixed-bundle runtime evidence', () => {
  const complete = nativeRuntimeEvidenceFixture()
  const nativeBundles = nativeBundleIdentitiesFixture(complete)
  const validate = documents =>
    validateNativeRuntimeEvidenceMatrix(documents, {
      expectedRevision: RUNTIME_REVISION,
      nativeBundles,
    })

  assert.throws(() => validate(complete.slice(1)), /missing certification for/)
  assert.throws(
    () => validate([...complete, structuredClone(complete[0])]),
    /duplicate certification/,
  )

  const mixedRevision = structuredClone(complete)
  mixedRevision[0].compilerBuildRevision = 'c'.repeat(40)
  assert.throws(() => validate(mixedRevision), /must equal release source revision/)

  const mixedBuild = structuredClone(complete)
  mixedBuild[0].compilerBuildId = `${RUNTIME_BUILD_ID}-different`
  assert.throws(() => validate(mixedBuild), /must report one compiler build ID/)

  const mixedBundle = structuredClone(complete)
  mixedBundle[1].binarySha256 = 'd'.repeat(64)
  assert.throws(() => validate(mixedBundle), /Node lanes must certify the same bundle/)

  const mismatchedReleaseBundles = new Map(nativeBundles)
  mismatchedReleaseBundles.set('darwin-arm64', {
    ...mismatchedReleaseBundles.get('darwin-arm64'),
    tarballSha256: 'e'.repeat(64),
  })
  assert.throws(
    () =>
      validateNativeRuntimeEvidenceMatrix(complete, {
        expectedRevision: RUNTIME_REVISION,
        nativeBundles: mismatchedReleaseBundles,
      }),
    /runtime evidence does not match the release bundle/,
  )
})

test('maps supported development hosts to their release package target', () => {
  assert.equal(nativeHostTarget({ platform: 'darwin', arch: 'arm64' }), 'darwin-arm64')
  assert.equal(
    nativeHostTarget({
      platform: 'linux',
      arch: 'x64',
      report: { header: { glibcVersionRuntime: '2.39' } },
    }),
    'linux-x64-gnu',
  )
  assert.equal(
    nativeHostTarget({ platform: 'linux', arch: 'arm64', report: { header: {} } }),
    'linux-arm64-musl',
  )
  assert.throws(
    () => nativeHostTarget({ platform: 'freebsd', arch: 'x64' }),
    /Unsupported Fict native compiler host/,
  )
})

test('invokes npm through the Windows command interpreter for native package assembly', () => {
  const args = ['pack', 'D:\\a\\fict package', '--json']
  assert.deepEqual(
    npmInvocation(args, {
      platform: 'win32',
      commandInterpreter: 'C:\\Windows\\System32\\cmd.exe',
    }),
    {
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'npm.cmd', ...args],
    },
  )
  assert.deepEqual(npmInvocation(args, { platform: 'linux' }), {
    command: 'npm',
    args,
  })
  assert.throws(() => npmInvocation(['pack', 1], { platform: 'win32' }), /must be strings/)
})

test('canonicalizes symlinked temp roots before creating local package dependencies', () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'fict-native-file-dependency-test-'))
  try {
    const physicalTempRoot = path.join(tempRoot, 'private', 'var')
    const aliasedTempRoot = path.join(tempRoot, 'var')
    const physicalConsumer = path.join(physicalTempRoot, 'folders', 'consumer')
    const aliasedConsumer = path.join(aliasedTempRoot, 'folders', 'consumer')
    const tarball = path.join(tempRoot, 'Users', 'runner', 'native-package.tgz')
    mkdirSync(physicalConsumer, { recursive: true })
    mkdirSync(path.dirname(tarball), { recursive: true })
    writeFileSync(tarball, 'native package')
    symlinkSync(physicalTempRoot, aliasedTempRoot, 'dir')

    const dependency = relativeFileDependency(aliasedConsumer, tarball)
    const resolvedByPackageManager = path.resolve(
      realpathSync(aliasedConsumer),
      dependency.slice('file:'.length),
    )

    assert.equal(realpathSync(resolvedByPackageManager), realpathSync(tarball))
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('invokes smoke package managers through the Windows command interpreter', () => {
  const args = ['--dir', 'D:\\a\\fict package', 'pack']
  const commandInterpreter = 'C:\\Windows\\System32\\cmd.exe'
  assert.deepEqual(
    packageCommandInvocation('pnpm', args, { platform: 'win32', commandInterpreter }),
    {
      command: commandInterpreter,
      args: ['/d', '/s', '/c', 'pnpm.cmd', ...args],
    },
  )
  assert.deepEqual(
    packageCommandInvocation('npm.cmd', args, { platform: 'win32', commandInterpreter }),
    {
      command: commandInterpreter,
      args: ['/d', '/s', '/c', 'npm.cmd', ...args],
    },
  )
  assert.deepEqual(packageCommandInvocation('node.exe', args, { platform: 'win32' }), {
    command: 'node.exe',
    args,
  })
  assert.deepEqual(packageCommandInvocation('pnpm', args, { platform: 'linux' }), {
    command: 'pnpm',
    args,
  })
  assert.throws(
    () => packageCommandInvocation('pnpm', ['install', 1], { platform: 'win32' }),
    /must be strings/,
  )
})

test('keeps facade optional dependencies, package manifests, allowlist, and Changesets aligned', () => {
  assert.deepEqual(validateNativePackageConfiguration(), [])
})

test('keeps the npm helper runtime aligned with the exact Rust OXC release', () => {
  const aligned = {
    cargoManifest:
      'oxc = { version = "=0.139.0", default-features = false }\noxc_traverse = "=0.139.0"\n',
    adapterSource: 'pub const OXC_VERSION: &str = "0.139.0";\n',
    loaderSource: "const EXPECTED_OXC_VERSION = '0.139.0'\n",
    compilerManifest: { dependencies: { '@oxc-project/runtime': '0.139.0' } },
  }
  assert.deepEqual(validateOxcVersionAlignment(aligned), [])
  assert.deepEqual(
    validateOxcVersionAlignment({
      ...aligned,
      compilerManifest: { dependencies: { '@oxc-project/runtime': '0.137.0' } },
    }),
    ['@oxc-project/runtime must match OXC 0.139.0; found 0.137.0'],
  )
})

test('enforces compressed and unpacked native package size budgets', () => {
  const budget = loadNativePackageSizeBudget()
  const withinBudget = evaluateNativePackageSize({
    target: 'darwin-arm64',
    tarballBytes: budget.maximumTarballBytes,
    unpackedBytes: budget.maximumUnpackedBytes,
    budget,
  })
  assert.equal(withinBudget.passed, true)
  assert.deepEqual(withinBudget.violations, [])

  const oversized = evaluateNativePackageSize({
    target: 'darwin-arm64',
    tarballBytes: budget.maximumTarballBytes + 1,
    unpackedBytes: budget.maximumUnpackedBytes + 1,
    budget,
  })
  assert.equal(oversized.passed, false)
  assert.equal(oversized.violations.length, 2)
  assert.match(oversized.violations[0], /tarball .* exceeds/)
  assert.match(oversized.violations[1], /unpacked package .* exceeds/)
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
    assert.equal(evidence.schemaVersion, 2)
    assert.equal(evidence.sizeGate.passed, true)
    assert.deepEqual(evidence.sizeGate, verified.buildEvidence.sizeGate)
    assert.match(
      readFileSync(`${verified.tarballPath}.sha256`, 'utf8'),
      new RegExp(`^${verified.tarballSha256}  `),
    )
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('refuses to certify a native bundle that exceeds its package budget', () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'fict-native-size-gate-test-'))
  try {
    const binaryPath = path.join(tempRoot, 'compiler.node')
    const budgetPath = path.join(tempRoot, 'budget.json')
    writeFileSync(binaryPath, 'native-test-binary')
    writeFileSync(
      budgetPath,
      `${JSON.stringify({
        schemaVersion: 1,
        profiles: {
          ci: {
            maximumNativeTarballBytes: 1,
            maximumNativeUnpackedBytes: 1,
          },
        },
      })}\n`,
    )
    assert.throws(
      () =>
        bundleNativePackage({
          target: 'darwin-arm64',
          binaryPath,
          outputDirectory: path.join(tempRoot, 'bundle'),
          budgetPath,
        }),
      /exceeds the ci size budget/,
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
