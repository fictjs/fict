#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
export const NATIVE_COMPILER_BINARY = 'fict_compiler_napi.node'
export const NATIVE_COMPILER_MANIFEST = 'binding-manifest.json'
export const NATIVE_COMPILER_CHECKSUMS = 'SHASUMS256.txt'
export const NATIVE_COMPILER_NODE_LANES = Object.freeze(['22.18.0', '24'])
export const NATIVE_COMPILER_BUDGET_PATH = path.join(
  repositoryRoot,
  '.github',
  'compiler-backend-budget.json',
)

const targetDefinitions = [
  {
    target: 'darwin-arm64',
    platform: 'darwin',
    arch: 'arm64',
    libc: null,
    rustTarget: 'aarch64-apple-darwin',
    runner: 'macos-15',
    sourceBinary: 'libfict_compiler_napi.dylib',
  },
  {
    target: 'darwin-x64',
    platform: 'darwin',
    arch: 'x64',
    libc: null,
    rustTarget: 'x86_64-apple-darwin',
    runner: 'macos-15-intel',
    sourceBinary: 'libfict_compiler_napi.dylib',
  },
  {
    target: 'linux-arm64-gnu',
    platform: 'linux',
    arch: 'arm64',
    libc: 'gnu',
    rustTarget: 'aarch64-unknown-linux-gnu',
    runner: 'ubuntu-24.04-arm',
    sourceBinary: 'libfict_compiler_napi.so',
  },
  {
    target: 'linux-arm64-musl',
    platform: 'linux',
    arch: 'arm64',
    libc: 'musl',
    rustTarget: 'aarch64-unknown-linux-musl',
    runner: 'ubuntu-24.04-arm',
    sourceBinary: 'libfict_compiler_napi.so',
  },
  {
    target: 'linux-x64-gnu',
    platform: 'linux',
    arch: 'x64',
    libc: 'gnu',
    rustTarget: 'x86_64-unknown-linux-gnu',
    runner: 'ubuntu-24.04',
    sourceBinary: 'libfict_compiler_napi.so',
  },
  {
    target: 'linux-x64-musl',
    platform: 'linux',
    arch: 'x64',
    libc: 'musl',
    rustTarget: 'x86_64-unknown-linux-musl',
    runner: 'ubuntu-24.04',
    sourceBinary: 'libfict_compiler_napi.so',
  },
  {
    target: 'win32-arm64-msvc',
    platform: 'win32',
    arch: 'arm64',
    libc: null,
    rustTarget: 'aarch64-pc-windows-msvc',
    runner: 'windows-11-arm',
    sourceBinary: 'fict_compiler_napi.dll',
  },
  {
    target: 'win32-x64-msvc',
    platform: 'win32',
    arch: 'x64',
    libc: null,
    rustTarget: 'x86_64-pc-windows-msvc',
    runner: 'windows-2025',
    sourceBinary: 'fict_compiler_napi.dll',
  },
]

export const NATIVE_COMPILER_TARGETS = Object.freeze(
  targetDefinitions.map(definition =>
    Object.freeze({
      ...definition,
      packageName: `@fictjs/compiler-${definition.target}`,
      packageDirectory: `packages/compiler-${definition.target}`,
      npmLibc: definition.libc === 'gnu' ? 'glibc' : definition.libc === 'musl' ? 'musl' : null,
    }),
  ),
)

export function nativeTargetDefinition(target) {
  const definition = NATIVE_COMPILER_TARGETS.find(candidate => candidate.target === target)
  if (!definition) throw new Error(`Unsupported Fict native compiler target: ${target}`)
  return definition
}

export function nativeHostTarget({
  platform = process.platform,
  arch = process.arch,
  report = process.report?.getReport(),
} = {}) {
  const libc =
    platform === 'linux'
      ? typeof report?.header?.glibcVersionRuntime === 'string'
        ? 'gnu'
        : 'musl'
      : null
  const definition = NATIVE_COMPILER_TARGETS.find(
    candidate =>
      candidate.platform === platform && candidate.arch === arch && candidate.libc === libc,
  )
  if (!definition) {
    throw new Error(
      `Unsupported Fict native compiler host: ${platform}/${arch}${libc ? `/${libc}` : ''}`,
    )
  }
  return definition.target
}

export function nativeArtifactName(target) {
  nativeTargetDefinition(target)
  return `fict-native-package-${target}`
}

export function nativeBuildMatrix() {
  return {
    include: NATIVE_COMPILER_TARGETS.map(definition => ({
      target: definition.target,
      runner: definition.runner,
      rustTarget: definition.rustTarget,
      binary: path.posix.join('target', definition.rustTarget, 'release', definition.sourceBinary),
      musl: definition.libc === 'musl',
    })),
  }
}

export function nativeRuntimeMatrix() {
  return {
    include: NATIVE_COMPILER_TARGETS.flatMap(definition =>
      NATIVE_COMPILER_NODE_LANES.map(node => ({
        target: definition.target,
        runner: definition.runner,
        node,
        musl: definition.libc === 'musl',
        dockerImage: definition.libc === 'musl' ? `node:${node}-alpine` : null,
      })),
    ),
  }
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

export function loadNativePackageSizeBudget({
  budgetPath = NATIVE_COMPILER_BUDGET_PATH,
  profile = 'ci',
} = {}) {
  const document = readJson(path.resolve(budgetPath))
  if (document.schemaVersion !== 1 || !document.profiles?.[profile]) {
    throw new Error(`Unknown native compiler package budget profile ${profile}`)
  }
  const source = document.profiles[profile]
  for (const name of ['maximumNativeTarballBytes', 'maximumNativeUnpackedBytes']) {
    if (!Number.isSafeInteger(source[name]) || source[name] <= 0) {
      throw new TypeError(
        `Native compiler package budget ${profile}.${name} must be a positive integer`,
      )
    }
  }
  return Object.freeze({
    profile,
    maximumTarballBytes: source.maximumNativeTarballBytes,
    maximumUnpackedBytes: source.maximumNativeUnpackedBytes,
  })
}

export function evaluateNativePackageSize({ target, tarballBytes, unpackedBytes, budget }) {
  nativeTargetDefinition(target)
  for (const [name, value] of Object.entries({ tarballBytes, unpackedBytes })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive integer`)
    }
  }
  if (
    !budget ||
    typeof budget.profile !== 'string' ||
    !Number.isSafeInteger(budget.maximumTarballBytes) ||
    !Number.isSafeInteger(budget.maximumUnpackedBytes)
  ) {
    throw new TypeError('A validated native compiler package size budget is required')
  }

  const violations = []
  if (tarballBytes > budget.maximumTarballBytes) {
    violations.push(`tarball ${tarballBytes} bytes exceeds ${budget.maximumTarballBytes} bytes`)
  }
  if (unpackedBytes > budget.maximumUnpackedBytes) {
    violations.push(
      `unpacked package ${unpackedBytes} bytes exceeds ${budget.maximumUnpackedBytes} bytes`,
    )
  }
  return Object.freeze({
    schemaVersion: 1,
    target,
    profile: budget.profile,
    tarballBytes,
    unpackedBytes,
    maximumTarballBytes: budget.maximumTarballBytes,
    maximumUnpackedBytes: budget.maximumUnpackedBytes,
    passed: violations.length === 0,
    violations: Object.freeze(violations),
  })
}

function assertNativePackageSize(sizeGate) {
  if (!sizeGate.passed) {
    throw new Error(
      `Native compiler package ${sizeGate.target} exceeds the ${sizeGate.profile} size budget:\n- ${sizeGate.violations.join('\n- ')}`,
    )
  }
}

function hashFile(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

function packageManifestPath(root, definition) {
  return path.join(root, definition.packageDirectory, 'package.json')
}

function sameMembers(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    [...actual].sort().join('\n') === [...expected].sort().join('\n')
  )
}

function sameStringRecord(actual, expected) {
  const actualEntries = Object.entries(actual ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  )
  const expectedEntries = Object.entries(expected).sort(([left], [right]) =>
    left.localeCompare(right),
  )
  return JSON.stringify(actualEntries) === JSON.stringify(expectedEntries)
}

export function validateOxcVersionAlignment({
  cargoManifest,
  adapterSource,
  loaderSource,
  compilerManifest,
}) {
  const failures = []
  const cargoVersion = cargoManifest.match(/^oxc = \{ version = "=(\d+\.\d+\.\d+)",/m)?.[1]
  const traverseVersion = cargoManifest.match(/^oxc_traverse = "=(\d+\.\d+\.\d+)"$/m)?.[1]
  const adapterVersion = adapterSource.match(
    /^pub const OXC_VERSION: &str = "(\d+\.\d+\.\d+)";$/m,
  )?.[1]
  const loaderVersion = loaderSource.match(/^const EXPECTED_OXC_VERSION = '(\d+\.\d+\.\d+)'$/m)?.[1]
  const runtimeVersion = compilerManifest.dependencies?.['@oxc-project/runtime']

  if (!cargoVersion) {
    failures.push('Cargo.toml must exactly pin the OXC workspace dependency')
    return failures
  }
  for (const [surface, version] of [
    ['Cargo oxc_traverse', traverseVersion],
    ['Rust adapter OXC_VERSION', adapterVersion],
    ['native loader EXPECTED_OXC_VERSION', loaderVersion],
    ['@oxc-project/runtime', runtimeVersion],
  ]) {
    if (version !== cargoVersion) {
      failures.push(`${surface} must match OXC ${cargoVersion}; found ${version ?? 'missing'}`)
    }
  }
  return failures
}

export function validateNativePackageConfiguration(root = repositoryRoot) {
  const failures = []
  const compiler = readJson(path.join(root, 'packages/compiler/package.json'))
  failures.push(
    ...validateOxcVersionAlignment({
      cargoManifest: readFileSync(path.join(root, 'Cargo.toml'), 'utf8'),
      adapterSource: readFileSync(path.join(root, 'crates/fict-compiler-oxc/src/lib.rs'), 'utf8'),
      loaderSource: readFileSync(path.join(root, 'packages/compiler/src/native-loader.ts'), 'utf8'),
      compilerManifest: compiler,
    }),
  )
  const expectedOptionalDependencies = Object.fromEntries(
    NATIVE_COMPILER_TARGETS.map(definition => [definition.packageName, 'workspace:*']),
  )

  if (!sameStringRecord(compiler.optionalDependencies, expectedOptionalDependencies)) {
    failures.push('@fictjs/compiler optionalDependencies must contain the exact native matrix')
  }

  for (const definition of NATIVE_COMPILER_TARGETS) {
    const manifestPath = packageManifestPath(root, definition)
    if (!existsSync(manifestPath)) {
      failures.push(`missing native package manifest: ${definition.packageDirectory}/package.json`)
      continue
    }
    const manifest = readJson(manifestPath)
    const expectedLibc = definition.npmLibc ? [definition.npmLibc] : undefined
    const actualLibc = manifest.libc

    if (manifest.name !== definition.packageName) {
      failures.push(`${definition.target} package name must be ${definition.packageName}`)
    }
    if (manifest.version !== compiler.version) {
      failures.push(
        `${definition.packageName} version must equal @fictjs/compiler ${compiler.version}`,
      )
    }
    if (!sameMembers(manifest.os, [definition.platform])) {
      failures.push(`${definition.packageName} os must be ${definition.platform}`)
    }
    if (!sameMembers(manifest.cpu, [definition.arch])) {
      failures.push(`${definition.packageName} cpu must be ${definition.arch}`)
    }
    if (
      (expectedLibc && !sameMembers(actualLibc, expectedLibc)) ||
      (!expectedLibc && actualLibc !== undefined)
    ) {
      failures.push(`${definition.packageName} libc must be ${expectedLibc?.[0] ?? 'absent'}`)
    }
    if (manifest.main !== NATIVE_COMPILER_BINARY) {
      failures.push(`${definition.packageName} main must be ${NATIVE_COMPILER_BINARY}`)
    }
    if (
      !sameMembers(manifest.files, [
        NATIVE_COMPILER_BINARY,
        NATIVE_COMPILER_MANIFEST,
        NATIVE_COMPILER_CHECKSUMS,
      ])
    ) {
      failures.push(`${definition.packageName} files must contain only native release artifacts`)
    }
    if (
      manifest.fictNative?.target !== definition.target ||
      manifest.fictNative?.rustTarget !== definition.rustTarget ||
      manifest.fictNative?.binary !== NATIVE_COMPILER_BINARY
    ) {
      failures.push(`${definition.packageName} fictNative metadata does not match the matrix`)
    }
    if (manifest.engines?.node !== '>=22.18.0') {
      failures.push(`${definition.packageName} must preserve the Node >=22.18.0 floor`)
    }
    if (
      manifest.publishConfig?.access !== 'public' ||
      manifest.publishConfig?.provenance !== true
    ) {
      failures.push(`${definition.packageName} must publish publicly with provenance`)
    }
  }

  const allowlist = readJson(path.join(root, '.github/npm-publish-packages.json')).packages ?? []
  for (const definition of NATIVE_COMPILER_TARGETS) {
    if (!allowlist.includes(definition.packageName)) {
      failures.push(`npm publish allowlist is missing ${definition.packageName}`)
    }
  }

  const changesets = readJson(path.join(root, '.changeset/config.json'))
  const compilerFixedGroup = (changesets.fixed ?? []).find(group =>
    group.includes('@fictjs/compiler'),
  )
  for (const definition of NATIVE_COMPILER_TARGETS) {
    if (!compilerFixedGroup?.includes(definition.packageName)) {
      failures.push(`Changesets compiler fixed group is missing ${definition.packageName}`)
    }
  }

  return failures
}

export function assembleNativePackage({
  target,
  binaryPath,
  outputDirectory,
  root = repositoryRoot,
}) {
  const definition = nativeTargetDefinition(target)
  const failures = validateNativePackageConfiguration(root)
  if (failures.length > 0) {
    throw new Error(`Invalid native package configuration:\n- ${failures.join('\n- ')}`)
  }
  if (!existsSync(binaryPath) || statSync(binaryPath).size === 0) {
    throw new Error(`Native compiler binary is missing or empty: ${binaryPath}`)
  }

  const sourceDirectory = path.join(root, definition.packageDirectory)
  const destination = path.resolve(outputDirectory)
  if (destination !== path.resolve(sourceDirectory)) {
    rmSync(destination, { recursive: true, force: true })
    mkdirSync(destination, { recursive: true })
    copyFileSync(path.join(sourceDirectory, 'package.json'), path.join(destination, 'package.json'))
  } else {
    mkdirSync(destination, { recursive: true })
  }

  const binaryDestination = path.join(destination, NATIVE_COMPILER_BINARY)
  copyFileSync(binaryPath, binaryDestination)
  const sha256 = hashFile(binaryDestination)
  const packageManifest = readJson(path.join(destination, 'package.json'))
  const bindingManifest = {
    schemaVersion: 1,
    packageName: definition.packageName,
    packageVersion: packageManifest.version,
    target: definition.target,
    rustTarget: definition.rustTarget,
    binary: NATIVE_COMPILER_BINARY,
    sha256,
  }
  writeFileSync(
    path.join(destination, NATIVE_COMPILER_MANIFEST),
    `${JSON.stringify(bindingManifest, null, 2)}\n`,
  )
  writeFileSync(
    path.join(destination, NATIVE_COMPILER_CHECKSUMS),
    `${sha256}  ${NATIVE_COMPILER_BINARY}\n`,
  )
  return { definition, directory: destination, manifest: bindingManifest }
}

export function verifyNativePackageArtifact({ target, packageDirectory }) {
  const definition = nativeTargetDefinition(target)
  const directory = path.resolve(packageDirectory)
  const packageManifest = readJson(path.join(directory, 'package.json'))
  const bindingManifest = readJson(path.join(directory, NATIVE_COMPILER_MANIFEST))
  const binaryPath = path.join(directory, NATIVE_COMPILER_BINARY)
  const checksumPath = path.join(directory, NATIVE_COMPILER_CHECKSUMS)
  const failures = []

  if (!existsSync(binaryPath) || statSync(binaryPath).size === 0) {
    failures.push(`${NATIVE_COMPILER_BINARY} is missing or empty`)
  }
  const sha256 = existsSync(binaryPath) ? hashFile(binaryPath) : null
  if (
    packageManifest.name !== definition.packageName ||
    packageManifest.fictNative?.target !== definition.target ||
    packageManifest.fictNative?.rustTarget !== definition.rustTarget
  ) {
    failures.push('package.json target metadata does not match the requested target')
  }
  if (
    bindingManifest.schemaVersion !== 1 ||
    bindingManifest.packageName !== definition.packageName ||
    bindingManifest.packageVersion !== packageManifest.version ||
    bindingManifest.target !== definition.target ||
    bindingManifest.rustTarget !== definition.rustTarget ||
    bindingManifest.binary !== NATIVE_COMPILER_BINARY ||
    bindingManifest.sha256 !== sha256
  ) {
    failures.push('binding-manifest.json does not match the package or binary')
  }
  const checksum = existsSync(checksumPath) ? readFileSync(checksumPath, 'utf8') : ''
  if (checksum !== `${sha256}  ${NATIVE_COMPILER_BINARY}\n`) {
    failures.push('SHASUMS256.txt does not match the packaged binary')
  }
  if (failures.length > 0) {
    throw new Error(`Invalid ${definition.packageName} artifact:\n- ${failures.join('\n- ')}`)
  }

  return { definition, directory, packageManifest, bindingManifest, binaryPath, sha256 }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status}):\n${result.stdout}${result.stderr}`,
    )
  }
  return result.stdout
}

function parseNpmPackOutput(output) {
  const start = output.indexOf('[')
  if (start < 0) throw new Error(`npm pack did not return JSON: ${output}`)
  const entries = JSON.parse(output.slice(start))
  if (!Array.isArray(entries) || entries.length !== 1) {
    throw new Error(`npm pack returned ${entries.length} package records`)
  }
  return entries[0]
}

export function npmInvocation(
  args,
  { platform = process.platform, commandInterpreter = process.env.ComSpec } = {},
) {
  if (!Array.isArray(args) || args.some(argument => typeof argument !== 'string')) {
    throw new TypeError('npm invocation arguments must be strings')
  }
  return platform === 'win32'
    ? {
        command: commandInterpreter || 'cmd.exe',
        args: ['/d', '/s', '/c', 'npm.cmd', ...args],
      }
    : { command: 'npm', args: [...args] }
}

export function packNativePackage({ target, packageDirectory, outputDirectory }) {
  const artifact = verifyNativePackageArtifact({ target, packageDirectory })
  const destination = path.resolve(outputDirectory)
  mkdirSync(destination, { recursive: true })
  const invocation = npmInvocation([
    'pack',
    artifact.directory,
    '--json',
    '--pack-destination',
    destination,
  ])
  const packed = parseNpmPackOutput(run(invocation.command, invocation.args))
  const requiredEntries = new Set([
    'package.json',
    NATIVE_COMPILER_BINARY,
    NATIVE_COMPILER_MANIFEST,
    NATIVE_COMPILER_CHECKSUMS,
  ])
  const packedEntries = new Set((packed.files ?? []).map(file => file.path))
  const missing = [...requiredEntries].filter(entry => !packedEntries.has(entry))
  if (missing.length > 0) {
    throw new Error(`${artifact.definition.packageName} tarball is missing: ${missing.join(', ')}`)
  }
  const tarballPath = path.join(destination, packed.filename)
  const tarballSha256 = hashFile(tarballPath)
  writeFileSync(`${tarballPath}.sha256`, `${tarballSha256}  ${packed.filename}\n`)
  return { ...artifact, packed, tarballPath, tarballSha256 }
}

export function verifyNativeBundle({
  target,
  bundleDirectory,
  budgetPath = NATIVE_COMPILER_BUDGET_PATH,
  budgetProfile = 'ci',
}) {
  const directory = path.resolve(bundleDirectory)
  const artifact = verifyNativePackageArtifact({
    target,
    packageDirectory: path.join(directory, 'package'),
  })
  const tarballs = readdirSync(directory).filter(file => file.endsWith('.tgz'))
  if (tarballs.length !== 1) {
    throw new Error(`${target} bundle must contain exactly one tarball; found ${tarballs.length}`)
  }
  const tarballPath = path.join(directory, tarballs[0])
  const tarballSha256 = hashFile(tarballPath)
  const checksumPath = `${tarballPath}.sha256`
  const checksum = existsSync(checksumPath) ? readFileSync(checksumPath, 'utf8') : ''
  if (checksum !== `${tarballSha256}  ${path.basename(tarballPath)}\n`) {
    throw new Error(`${target} tarball checksum is missing or invalid`)
  }
  const evidencePath = path.join(directory, 'build-evidence.json')
  if (!existsSync(evidencePath)) throw new Error(`${target} build evidence is missing`)
  const buildEvidence = readJson(evidencePath)
  const sizeGate = evaluateNativePackageSize({
    target,
    tarballBytes: statSync(tarballPath).size,
    unpackedBytes: buildEvidence.unpackedBytes,
    budget: loadNativePackageSizeBudget({ budgetPath, profile: budgetProfile }),
  })
  if (
    buildEvidence.schemaVersion !== 2 ||
    buildEvidence.target !== target ||
    buildEvidence.rustTarget !== artifact.definition.rustTarget ||
    buildEvidence.packageName !== artifact.definition.packageName ||
    buildEvidence.packageVersion !== artifact.packageManifest.version ||
    buildEvidence.binarySha256 !== artifact.sha256 ||
    buildEvidence.tarball !== path.basename(tarballPath) ||
    buildEvidence.tarballSha256 !== tarballSha256 ||
    !Number.isInteger(buildEvidence.tarballBytes) ||
    buildEvidence.tarballBytes !== statSync(tarballPath).size ||
    !Number.isInteger(buildEvidence.unpackedBytes) ||
    typeof buildEvidence.npmIntegrity !== 'string' ||
    JSON.stringify(buildEvidence.sizeGate) !== JSON.stringify(sizeGate)
  ) {
    throw new Error(`${target} build evidence does not match the certified bundle`)
  }
  assertNativePackageSize(sizeGate)
  return { ...artifact, tarballPath, tarballSha256, buildEvidence }
}

export function bundleNativePackage({
  target,
  binaryPath,
  outputDirectory,
  budgetPath = NATIVE_COMPILER_BUDGET_PATH,
  budgetProfile = 'ci',
}) {
  const destination = path.resolve(outputDirectory)
  rmSync(destination, { recursive: true, force: true })
  mkdirSync(destination, { recursive: true })
  assembleNativePackage({
    target,
    binaryPath: path.resolve(binaryPath),
    outputDirectory: path.join(destination, 'package'),
  })
  const packed = packNativePackage({
    target,
    packageDirectory: path.join(destination, 'package'),
    outputDirectory: destination,
  })
  const tarballBytes = statSync(packed.tarballPath).size
  const unpackedBytes = packed.packed.unpackedSize
  const sizeGate = evaluateNativePackageSize({
    target,
    tarballBytes,
    unpackedBytes,
    budget: loadNativePackageSizeBudget({ budgetPath, profile: budgetProfile }),
  })
  assertNativePackageSize(sizeGate)
  const evidence = {
    schemaVersion: 2,
    target,
    rustTarget: packed.definition.rustTarget,
    packageName: packed.definition.packageName,
    packageVersion: packed.packageManifest.version,
    binarySha256: packed.sha256,
    tarball: path.basename(packed.tarballPath),
    tarballSha256: packed.tarballSha256,
    tarballBytes,
    unpackedBytes,
    npmIntegrity: packed.packed.integrity,
    sizeGate,
  }
  writeFileSync(
    path.join(destination, 'build-evidence.json'),
    `${JSON.stringify(evidence, null, 2)}\n`,
  )
  return evidence
}

const GIT_REVISION_PATTERN = /^[0-9a-f]{40}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/

function nativeRuntimePairKey(target, nodeLane) {
  return `${target}:node-${nodeLane}`
}

export function nativeNodeVersionMatchesLane(version, nodeLane) {
  if (nodeLane === '22.18.0') return version === 'v22.18.0'
  if (nodeLane === '24') return /^v24\.\d+\.\d+$/.test(version ?? '')
  return false
}

function collectJsonFiles(directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) collectJsonFiles(entryPath, files)
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(entryPath)
  }
  return files
}

function loadNativeRuntimeEvidence(directory) {
  const evidenceDirectory = path.resolve(directory)
  if (!existsSync(evidenceDirectory) || !statSync(evidenceDirectory).isDirectory()) {
    throw new Error(`Native runtime evidence directory does not exist: ${evidenceDirectory}`)
  }
  const files = collectJsonFiles(evidenceDirectory).sort()
  if (files.length === 0) {
    throw new Error(
      `Native runtime evidence directory contains no JSON files: ${evidenceDirectory}`,
    )
  }
  return files.map(file => {
    try {
      return readJson(file)
    } catch (error) {
      throw new Error(`Invalid native runtime evidence JSON ${file}: ${error.message}`, {
        cause: error,
      })
    }
  })
}

function nativeBundleIdentity(bundle) {
  return Object.freeze({
    packageVersion: bundle.packageManifest.version,
    binarySha256: bundle.sha256,
    tarballSha256: bundle.tarballSha256,
    tarballBytes: bundle.buildEvidence.tarballBytes,
    unpackedBytes: bundle.buildEvidence.unpackedBytes,
    sizeGate: bundle.buildEvidence.sizeGate,
  })
}

function loadNativeReleaseBundleIdentities(directory) {
  const artifactsRoot = path.resolve(directory)
  return new Map(
    NATIVE_COMPILER_TARGETS.map(definition => {
      const bundle = verifyNativeBundle({
        target: definition.target,
        bundleDirectory: path.join(artifactsRoot, nativeArtifactName(definition.target)),
      })
      return [definition.target, nativeBundleIdentity(bundle)]
    }),
  )
}

export function validateNativeRuntimeEvidenceMatrix(
  documents,
  { expectedRevision, nativeBundles } = {},
) {
  if (!Array.isArray(documents)) {
    throw new TypeError('Native runtime evidence must be an array')
  }
  if (!GIT_REVISION_PATTERN.test(expectedRevision ?? '')) {
    throw new TypeError('expectedRevision must be a lowercase 40-character Git SHA-1')
  }
  if (!(nativeBundles instanceof Map)) {
    throw new TypeError('nativeBundles must be a Map of verified release bundle identities')
  }

  const expectedPairs = new Set(
    NATIVE_COMPILER_TARGETS.flatMap(definition =>
      NATIVE_COMPILER_NODE_LANES.map(nodeLane => nativeRuntimePairKey(definition.target, nodeLane)),
    ),
  )
  const evidenceByPair = new Map()
  const compilerBuildIds = new Set()
  const packageVersions = new Set()
  const budgetFingerprints = new Set()
  const capabilityManifestDigests = new Set()
  const compatibilityCorpusIdentities = new Set()
  const failures = []

  if (documents.length !== expectedPairs.size) {
    failures.push(
      `expected exactly ${expectedPairs.size} target/Node certifications; found ${documents.length}`,
    )
  }
  if (nativeBundles.size !== NATIVE_COMPILER_TARGETS.length) {
    failures.push(
      `expected exactly ${NATIVE_COMPILER_TARGETS.length} native release bundles; found ${nativeBundles.size}`,
    )
  }

  for (const [index, evidence] of documents.entries()) {
    const label = `evidence[${index}]`
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
      failures.push(`${label} must be a JSON object`)
      continue
    }

    const definition = NATIVE_COMPILER_TARGETS.find(
      candidate => candidate.target === evidence.target,
    )
    const validNodeLane = NATIVE_COMPILER_NODE_LANES.includes(evidence.nodeLane)
    const pair =
      definition && validNodeLane
        ? nativeRuntimePairKey(definition.target, evidence.nodeLane)
        : null
    const evidenceLabel = pair ?? label

    if (!definition) failures.push(`${label} has unsupported target ${String(evidence.target)}`)
    if (!validNodeLane) {
      failures.push(`${label} has unsupported Node lane ${String(evidence.nodeLane)}`)
    }
    if (pair) {
      if (evidenceByPair.has(pair)) failures.push(`duplicate certification for ${pair}`)
      else evidenceByPair.set(pair, evidence)
    }

    if (evidence.schemaVersion !== 3) {
      failures.push(`${evidenceLabel} must use runtime evidence schema v3`)
    }
    if (definition) {
      for (const [field, expected] of [
        ['rustTarget', definition.rustTarget],
        ['platform', definition.platform],
        ['arch', definition.arch],
        ['libc', definition.libc],
        ['packageName', definition.packageName],
      ]) {
        if (evidence[field] !== expected) {
          failures.push(`${evidenceLabel}.${field} must be ${String(expected)}`)
        }
      }
    }
    if (validNodeLane && !nativeNodeVersionMatchesLane(evidence.node, evidence.nodeLane)) {
      failures.push(
        `${evidenceLabel}.node ${String(evidence.node)} does not match lane ${evidence.nodeLane}`,
      )
    }
    if (typeof evidence.packageVersion !== 'string' || !evidence.packageVersion) {
      failures.push(`${evidenceLabel}.packageVersion must be a non-empty string`)
    } else {
      packageVersions.add(evidence.packageVersion)
    }
    for (const field of ['binarySha256', 'tarballSha256']) {
      if (!SHA256_PATTERN.test(evidence[field] ?? '')) {
        failures.push(`${evidenceLabel}.${field} must be a lowercase SHA-256`)
      }
    }
    for (const field of ['tarballBytes', 'unpackedBytes']) {
      if (!Number.isSafeInteger(evidence[field]) || evidence[field] <= 0) {
        failures.push(`${evidenceLabel}.${field} must be a positive integer`)
      }
    }
    if (typeof evidence.compilerBuildId !== 'string' || !evidence.compilerBuildId) {
      failures.push(`${evidenceLabel}.compilerBuildId must be a non-empty string`)
    } else {
      compilerBuildIds.add(evidence.compilerBuildId)
    }
    if (evidence.compilerBuildRevision !== expectedRevision) {
      failures.push(
        `${evidenceLabel}.compilerBuildRevision must equal release source revision ${expectedRevision}`,
      )
    }
    if (
      evidence.compilerCapabilityManifestVersion !== 1 ||
      !/^sha256:[0-9a-f]{64}$/.test(evidence.compilerCapabilityManifestDigest ?? '') ||
      evidence.compilerCapabilityPackageVersion !== evidence.packageVersion
    ) {
      failures.push(`${evidenceLabel} compiler capability manifest is incomplete or mismatched`)
    } else {
      capabilityManifestDigests.add(evidence.compilerCapabilityManifestDigest)
    }
    const compatibilityCorpus = evidence.compatibilityCorpus
    if (
      compatibilityCorpus?.schemaVersion !== 1 ||
      compatibilityCorpus.corpusSchemaVersion !== 5 ||
      !/^sha256:[0-9a-f]{64}$/.test(compatibilityCorpus.corpusSha256 ?? '') ||
      !Number.isSafeInteger(compatibilityCorpus.fixtures) ||
      compatibilityCorpus.fixtures <= 0 ||
      !GIT_REVISION_PATTERN.test(compatibilityCorpus.reviewedRevision ?? '') ||
      typeof compatibilityCorpus.reviewedCompilerBuildId !== 'string' ||
      !compatibilityCorpus.reviewedCompilerBuildId
    ) {
      failures.push(`${evidenceLabel}.compatibilityCorpus is incomplete`)
    } else {
      compatibilityCorpusIdentities.add(JSON.stringify(compatibilityCorpus))
    }
    if (!sameMembers(evidence.formats, ['cjs', 'esm'])) {
      failures.push(`${evidenceLabel}.formats must contain exactly cjs and esm`)
    }
    if (evidence.syncAndAsync !== true) {
      failures.push(`${evidenceLabel}.syncAndAsync must be true`)
    }
    if (evidence.rustToolchainRequired !== false) {
      failures.push(`${evidenceLabel}.rustToolchainRequired must be false`)
    }

    const sizeGate = evidence.sizeGate
    if (
      sizeGate?.schemaVersion !== 1 ||
      sizeGate.target !== evidence.target ||
      typeof sizeGate.profile !== 'string' ||
      !sizeGate.profile ||
      sizeGate.tarballBytes !== evidence.tarballBytes ||
      sizeGate.unpackedBytes !== evidence.unpackedBytes ||
      !Number.isSafeInteger(sizeGate.maximumTarballBytes) ||
      sizeGate.maximumTarballBytes <= 0 ||
      !Number.isSafeInteger(sizeGate.maximumUnpackedBytes) ||
      sizeGate.maximumUnpackedBytes <= 0 ||
      evidence.tarballBytes > sizeGate.maximumTarballBytes ||
      evidence.unpackedBytes > sizeGate.maximumUnpackedBytes ||
      sizeGate.passed !== true ||
      !Array.isArray(sizeGate.violations) ||
      sizeGate.violations.length !== 0
    ) {
      failures.push(`${evidenceLabel}.sizeGate is incomplete or does not pass`)
    } else {
      budgetFingerprints.add(
        JSON.stringify([
          sizeGate.profile,
          sizeGate.maximumTarballBytes,
          sizeGate.maximumUnpackedBytes,
        ]),
      )
    }
  }

  for (const pair of expectedPairs) {
    if (!evidenceByPair.has(pair)) failures.push(`missing certification for ${pair}`)
  }
  if (compilerBuildIds.size !== 1) {
    failures.push('all runtime certifications must report one compiler build ID')
  }
  if (packageVersions.size !== 1) {
    failures.push('all runtime certifications must report one native package version')
  }
  if (budgetFingerprints.size !== 1) {
    failures.push('all runtime certifications must use one native package size budget')
  }
  if (capabilityManifestDigests.size !== 1) {
    failures.push('all runtime certifications must report one compiler capability manifest')
  }
  if (compatibilityCorpusIdentities.size !== 1) {
    failures.push('all runtime certifications must replay one frozen compatibility corpus')
  }

  const releaseBundleFields = [
    'packageVersion',
    'binarySha256',
    'tarballSha256',
    'tarballBytes',
    'unpackedBytes',
    'sizeGate',
  ]
  const laneIdentityFields = [
    ...releaseBundleFields,
    'compilerBuildId',
    'compilerBuildRevision',
    'compilerCapabilityManifestVersion',
    'compilerCapabilityManifestDigest',
    'compilerCapabilityPackageVersion',
    'compatibilityCorpus',
  ]
  for (const definition of NATIVE_COMPILER_TARGETS) {
    const certifications = NATIVE_COMPILER_NODE_LANES.map(nodeLane =>
      evidenceByPair.get(nativeRuntimePairKey(definition.target, nodeLane)),
    )
    if (certifications.some(evidence => !evidence)) continue
    const [baseline, comparison] = certifications
    const changedFields = laneIdentityFields.filter(
      field => JSON.stringify(baseline[field]) !== JSON.stringify(comparison[field]),
    )
    if (changedFields.length > 0) {
      failures.push(
        `${definition.target} Node lanes must certify the same bundle; changed ${changedFields.join(', ')}`,
      )
    }

    const releaseBundle = nativeBundles.get(definition.target)
    if (!releaseBundle) {
      failures.push(`missing release bundle for ${definition.target}`)
      continue
    }
    const mismatchedReleaseFields = releaseBundleFields.filter(
      field => JSON.stringify(baseline[field]) !== JSON.stringify(releaseBundle[field]),
    )
    if (mismatchedReleaseFields.length > 0) {
      failures.push(
        `${definition.target} runtime evidence does not match the release bundle; changed ${mismatchedReleaseFields.join(', ')}`,
      )
    }
  }

  for (const target of nativeBundles.keys()) {
    if (!NATIVE_COMPILER_TARGETS.some(definition => definition.target === target)) {
      failures.push(`unexpected release bundle for ${String(target)}`)
    }
  }

  if (failures.length > 0) {
    throw new Error(`Invalid native runtime evidence matrix:\n- ${failures.join('\n- ')}`)
  }

  const payload = {
    schemaVersion: 3,
    status: 'pass',
    targets: NATIVE_COMPILER_TARGETS.length,
    nodeLanes: Object.freeze([...NATIVE_COMPILER_NODE_LANES]),
    certifications: expectedPairs.size,
    bundles: NATIVE_COMPILER_TARGETS.length,
    certifiedPairs: Object.freeze([...expectedPairs]),
    runtimeEvidence: Object.freeze(
      [...expectedPairs].map(pair => {
        const evidence = evidenceByPair.get(pair)
        return Object.freeze({
          pair,
          target: evidence.target,
          nodeLane: evidence.nodeLane,
          node: evidence.node,
          evidenceDigest: `sha256:${createHash('sha256')
            .update(JSON.stringify(evidence))
            .digest('hex')}`,
        })
      }),
    ),
    releaseBundles: Object.freeze(
      NATIVE_COMPILER_TARGETS.map(definition =>
        Object.freeze({
          target: definition.target,
          ...nativeBundles.get(definition.target),
        }),
      ),
    ),
    packageVersion: [...packageVersions][0],
    compilerBuildId: [...compilerBuildIds][0],
    compilerBuildRevision: expectedRevision,
    compilerCapabilityManifestVersion: 1,
    compilerCapabilityManifestDigest: [...capabilityManifestDigests][0],
    compilerCapabilityPackageVersion: [...packageVersions][0],
    compatibilityCorpus: JSON.parse([...compatibilityCorpusIdentities][0]),
  }
  return Object.freeze({
    ...payload,
    certificationDigest: `sha256:${createHash('sha256')
      .update(JSON.stringify(payload))
      .digest('hex')}`,
  })
}

function parseArguments(args) {
  const [command, ...rest] = args
  const options = {}
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`)
    const value = rest[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`)
    options[argument.slice(2)] = value
    index += 1
  }
  return { command, options }
}

function main() {
  const { command, options } = parseArguments(process.argv.slice(2))
  if (command === 'matrix') {
    const matrix = options.kind === 'build' ? nativeBuildMatrix() : nativeRuntimeMatrix()
    if (options.kind !== 'build' && options.kind !== 'runtime') {
      throw new Error('--kind must be build or runtime')
    }
    process.stdout.write(`${JSON.stringify(matrix)}\n`)
    return
  }
  if (command === 'check') {
    const failures = validateNativePackageConfiguration()
    if (failures.length > 0) throw new Error(failures.join('\n'))
    process.stdout.write(
      `${JSON.stringify({ targets: NATIVE_COMPILER_TARGETS.length, nodeLanes: NATIVE_COMPILER_NODE_LANES })}\n`,
    )
    return
  }
  if (command === 'bundle') {
    const evidence = bundleNativePackage({
      target: options.target,
      binaryPath: options.binary,
      outputDirectory: options.output,
      budgetPath: options.budget,
      budgetProfile: options.profile,
    })
    process.stdout.write(`${JSON.stringify(evidence)}\n`)
    return
  }
  if (command === 'verify-bundle') {
    const bundle = verifyNativeBundle({
      target: options.target,
      bundleDirectory: options.bundle,
      budgetPath: options.budget,
      budgetProfile: options.profile,
    })
    process.stdout.write(
      `${JSON.stringify({ target: options.target, tarballSha256: bundle.tarballSha256 })}\n`,
    )
    return
  }
  if (command === 'verify-runtime-evidence') {
    if (!options.evidence || !options.artifacts || !options.revision) {
      throw new Error('verify-runtime-evidence requires --evidence, --artifacts, and --revision')
    }
    const result = validateNativeRuntimeEvidenceMatrix(
      loadNativeRuntimeEvidence(options.evidence),
      {
        expectedRevision: options.revision,
        nativeBundles: loadNativeReleaseBundleIdentities(options.artifacts),
      },
    )
    const output = `${JSON.stringify(result, null, 2)}\n`
    if (options.output) {
      const outputPath = path.resolve(options.output)
      mkdirSync(path.dirname(outputPath), { recursive: true })
      writeFileSync(outputPath, output)
    }
    process.stdout.write(output)
    return
  }
  throw new Error(
    'Usage: native-compiler-packages.mjs <check|matrix|bundle|verify-bundle|verify-runtime-evidence>',
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(`[native-compiler-packages] ${error.stack ?? error.message ?? error}`)
    process.exitCode = 1
  }
}
