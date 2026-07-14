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

export function validateNativePackageConfiguration(root = repositoryRoot) {
  const failures = []
  const compiler = readJson(path.join(root, 'packages/compiler/package.json'))
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

export function packNativePackage({ target, packageDirectory, outputDirectory }) {
  const artifact = verifyNativePackageArtifact({ target, packageDirectory })
  const destination = path.resolve(outputDirectory)
  mkdirSync(destination, { recursive: true })
  const packed = parseNpmPackOutput(
    run('npm', ['pack', artifact.directory, '--json', '--pack-destination', destination]),
  )
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

export function verifyNativeBundle({ target, bundleDirectory }) {
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
  if (
    buildEvidence.schemaVersion !== 1 ||
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
    typeof buildEvidence.npmIntegrity !== 'string'
  ) {
    throw new Error(`${target} build evidence does not match the certified bundle`)
  }
  return { ...artifact, tarballPath, tarballSha256, buildEvidence }
}

export function bundleNativePackage({ target, binaryPath, outputDirectory }) {
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
  const evidence = {
    schemaVersion: 1,
    target,
    rustTarget: packed.definition.rustTarget,
    packageName: packed.definition.packageName,
    packageVersion: packed.packageManifest.version,
    binarySha256: packed.sha256,
    tarball: path.basename(packed.tarballPath),
    tarballSha256: packed.tarballSha256,
    tarballBytes: statSync(packed.tarballPath).size,
    unpackedBytes: packed.packed.unpackedSize,
    npmIntegrity: packed.packed.integrity,
  }
  writeFileSync(
    path.join(destination, 'build-evidence.json'),
    `${JSON.stringify(evidence, null, 2)}\n`,
  )
  return evidence
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
    })
    process.stdout.write(`${JSON.stringify(evidence)}\n`)
    return
  }
  if (command === 'verify-bundle') {
    const bundle = verifyNativeBundle({
      target: options.target,
      bundleDirectory: options.bundle,
    })
    process.stdout.write(
      `${JSON.stringify({ target: options.target, tarballSha256: bundle.tarballSha256 })}\n`,
    )
    return
  }
  throw new Error(`Usage: native-compiler-packages.mjs <check|matrix|bundle|verify-bundle>`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(`[native-compiler-packages] ${error.stack ?? error.message ?? error}`)
    process.exitCode = 1
  }
}
