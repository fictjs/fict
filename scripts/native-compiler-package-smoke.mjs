#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  COMPILER_CAPABILITY_MANIFEST_VERSION,
  NATIVE_COMPILER_NODE_LANES,
  NATIVE_COMPILER_TARGETS,
  bundleNativePackage,
  nativeNodeVersionMatchesLane,
  repositoryRoot,
  verifyNativeBundle,
} from './native-compiler-packages.mjs'
import { replayCompilerCorpus } from './lib/compiler-corpus-replay.mjs'

const packageManager = 'pnpm'
const windowsPackageManagerCommand = /^(?:npm|pnpm)(?:\.cmd)?$/i

function parseArguments(args) {
  const options = {}
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`)
    const value = args[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`)
    options[argument.slice(2)] = value
    index += 1
  }
  return options
}

function detectHostTarget() {
  const libc =
    process.platform === 'linux'
      ? typeof process.report?.getReport()?.header?.glibcVersionRuntime === 'string'
        ? 'gnu'
        : 'musl'
      : null
  const definition = NATIVE_COMPILER_TARGETS.find(
    candidate =>
      candidate.platform === process.platform &&
      candidate.arch === process.arch &&
      candidate.libc === libc,
  )
  if (!definition) {
    throw new Error(`The native package smoke does not support ${process.platform}/${process.arch}`)
  }
  return definition
}

export function packageCommandInvocation(
  command,
  args,
  { platform = process.platform, commandInterpreter = process.env.ComSpec } = {},
) {
  if (typeof command !== 'string' || command.length === 0) {
    throw new TypeError('Package command must be a non-empty string')
  }
  if (!Array.isArray(args) || args.some(argument => typeof argument !== 'string')) {
    throw new TypeError('Package command arguments must be strings')
  }
  if (platform === 'win32' && windowsPackageManagerCommand.test(command)) {
    const commandFile = command.toLowerCase().endsWith('.cmd') ? command : `${command}.cmd`
    return {
      command: commandInterpreter || 'cmd.exe',
      args: ['/d', '/s', '/c', commandFile, ...args],
    }
  }
  return { command, args: [...args] }
}

function run(command, args, options = {}) {
  const invocation = packageCommandInvocation(command, args)
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const output = options.capture ? `${result.stdout}${result.stderr}` : ''
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status})${output ? `:\n${output}` : ''}`,
    )
  }
  return options.capture ? result.stdout : ''
}

function packCompilerFacade(packsDirectory) {
  const packageDirectory = path.join(repositoryRoot, 'packages/compiler')
  if (!existsSync(path.join(packageDirectory, 'dist/native-loader.js'))) {
    throw new Error('Build @fictjs/compiler before running the native package smoke')
  }
  const before = new Set(readdirSync(packsDirectory))
  run(packageManager, ['--dir', packageDirectory, 'pack', '--pack-destination', packsDirectory])
  const created = readdirSync(packsDirectory).filter(
    file => file.endsWith('.tgz') && !before.has(file),
  )
  if (created.length !== 1)
    throw new Error(`Compiler facade pack created ${created.length} tarballs`)
  return path.join(packsDirectory, created[0])
}

export function relativeFileDependency(fromDirectory, filePath) {
  const canonicalFromDirectory = realpathSync(fromDirectory)
  const canonicalFilePath = realpathSync(filePath)
  return `file:${path
    .relative(canonicalFromDirectory, canonicalFilePath)
    .split(path.sep)
    .join('/')}`
}

export function removeNativeSmokeTemporaryDirectory(directory, remove = rmSync) {
  remove(directory, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  })
}

export function nativeCompilerCorpusReplayInvocation(
  consumerDirectory,
  { executable = process.execPath, scriptPath = fileURLToPath(import.meta.url) } = {},
) {
  return {
    command: executable,
    args: [scriptPath, '--replay-consumer', consumerDirectory],
  }
}

function packResolutionOnlyNativePackages(tempRoot, packsDirectory, host, hostTarball) {
  const tarballs = new Map([[host.packageName, hostTarball]])
  const stubsRoot = path.join(tempRoot, 'resolution-only-native-packages')
  mkdirSync(stubsRoot)
  for (const target of NATIVE_COMPILER_TARGETS) {
    if (target.target === host.target) continue
    const sourceManifest = JSON.parse(
      readFileSync(path.join(repositoryRoot, target.packageDirectory, 'package.json'), 'utf8'),
    )
    const stubDirectory = path.join(stubsRoot, target.target)
    mkdirSync(stubDirectory)
    writeFileSync(
      path.join(stubDirectory, 'package.json'),
      `${JSON.stringify(
        {
          ...sourceManifest,
          description: `${sourceManifest.description} (resolution-only smoke fixture)`,
          main: undefined,
          files: [],
        },
        null,
        2,
      )}\n`,
    )
    const output = run(
      'npm',
      ['pack', stubDirectory, '--json', '--pack-destination', packsDirectory],
      { capture: true },
    )
    const packed = JSON.parse(output.slice(output.indexOf('[')))[0]
    tarballs.set(target.packageName, path.join(packsDirectory, packed.filename))
  }
  return tarballs
}

function writeConsumers(consumerDirectory) {
  const request = `{
    protocolVersion: 1,
    code: 'export const answer: number = 42',
    filename: '/fixtures/native-package.ts',
    options: { sourcemap: true }
  }`
  writeFileSync(
    path.join(consumerDirectory, 'smoke.mjs'),
    `import assert from 'node:assert/strict'
import { loadNativeCompilerBinding } from '@fictjs/compiler/native'
const binding = loadNativeCompilerBinding()
const info = binding.nativeCompilerInfo()
const syncResult = binding.transformSync(${request})
const asyncResult = await binding.transform(${request})
assert.deepEqual(syncResult.diagnostics, [])
assert.deepEqual(asyncResult.diagnostics, [])
assert.match(syncResult.code, /answer = 42/)
assert.doesNotMatch(syncResult.code, /: number/)
assert.equal(asyncResult.code, syncResult.code)
console.log(JSON.stringify({ format: 'esm', info, compilerBuildId: syncResult.compilerBuildId }))
`,
  )
  writeFileSync(
    path.join(consumerDirectory, 'smoke.cjs'),
    `'use strict'
const assert = require('node:assert/strict')
const { loadNativeCompilerBinding } = require('@fictjs/compiler/native')
;(async () => {
  const binding = loadNativeCompilerBinding()
  const info = binding.nativeCompilerInfo()
  const syncResult = binding.transformSync(${request})
  const asyncResult = await binding.transform(${request})
  assert.deepEqual(syncResult.diagnostics, [])
  assert.deepEqual(asyncResult.diagnostics, [])
  assert.equal(asyncResult.code, syncResult.code)
  console.log(JSON.stringify({ format: 'cjs', info, compilerBuildId: syncResult.compilerBuildId }))
})().catch(error => {
  console.error(error)
  process.exitCode = 1
})
`,
  )
}

function parseLastJsonLine(output) {
  const line = output
    .trim()
    .split(/\r?\n/)
    .findLast(candidate => candidate.startsWith('{'))
  if (!line) throw new Error(`Native smoke returned no JSON evidence: ${output}`)
  return JSON.parse(line)
}

function replayInstalledCompilerCorpus(consumerDirectory) {
  const consumerRequire = createRequire(path.join(consumerDirectory, 'package.json'))
  const installedFacade = consumerRequire('@fictjs/compiler/native')
  const installedBinding = installedFacade.loadNativeCompilerBinding()
  const corpusSource = readFileSync(
    path.join(repositoryRoot, 'crates/fict-compiler/tests/rust_frozen_codegen_corpus.json'),
    'utf8',
  )
  return replayCompilerCorpus(installedBinding, JSON.parse(corpusSource), corpusSource)
}

function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options['replay-consumer']) {
    const compatibilityCorpus = replayInstalledCompilerCorpus(
      path.resolve(options['replay-consumer']),
    )
    process.stdout.write(`${JSON.stringify(compatibilityCorpus)}\n`)
    return
  }
  const host = detectHostTarget()
  const target = options.target ?? host.target
  assert.equal(target, host.target, `Runtime host ${host.target} cannot certify ${target}`)
  const nodeLane = options['node-lane'] ?? null
  if (nodeLane !== null) {
    assert.ok(
      NATIVE_COMPILER_NODE_LANES.includes(nodeLane),
      `Unsupported native runtime Node lane: ${nodeLane}`,
    )
    assert.ok(
      nativeNodeVersionMatchesLane(process.version, nodeLane),
      `Runtime Node ${process.version} does not match declared lane ${nodeLane}`,
    )
  }
  const expectedRevision =
    options['expected-revision'] ?? process.env.FICT_COMPILER_BUILD_REVISION ?? null
  if (expectedRevision !== null) {
    assert.match(
      expectedRevision,
      /^[0-9a-f]{40}$/,
      'Expected native compiler revision must be a lowercase 40-character Git SHA-1',
    )
  }

  const tempRoot = mkdtempSync(path.join(os.tmpdir(), `fict-native-${target}-`))
  const packsDirectory = path.join(tempRoot, 'packs')
  const consumerDirectory = path.join(tempRoot, 'consumer')
  mkdirSync(packsDirectory)
  mkdirSync(consumerDirectory)

  try {
    let bundleDirectory = options.bundle ? path.resolve(options.bundle) : null
    if (!bundleDirectory) {
      if (!options['host-binary']) throw new Error('Provide --bundle or --host-binary')
      bundleDirectory = path.join(tempRoot, 'bundle')
      bundleNativePackage({
        target,
        binaryPath: path.resolve(options['host-binary']),
        outputDirectory: bundleDirectory,
      })
    }
    const nativeBundle = verifyNativeBundle({ target, bundleDirectory })
    const compilerTarball = options['compiler-tarball']
      ? path.resolve(options['compiler-tarball'])
      : packCompilerFacade(packsDirectory)
    if (!existsSync(compilerTarball)) {
      throw new Error(`Compiler facade tarball does not exist: ${compilerTarball}`)
    }
    const compilerDependency = relativeFileDependency(consumerDirectory, compilerTarball)
    const nativeDependency = relativeFileDependency(consumerDirectory, nativeBundle.tarballPath)
    const nativeTarballs = packResolutionOnlyNativePackages(
      tempRoot,
      packsDirectory,
      host,
      nativeBundle.tarballPath,
    )
    const nativeOverrides = Object.fromEntries(
      NATIVE_COMPILER_TARGETS.map(candidate => [
        `@fictjs/compiler>${candidate.packageName}`,
        relativeFileDependency(consumerDirectory, nativeTarballs.get(candidate.packageName)),
      ]),
    )
    writeFileSync(
      path.join(consumerDirectory, 'package.json'),
      `${JSON.stringify(
        {
          name: 'fict-native-package-clean-install',
          private: true,
          type: 'module',
          packageManager: 'pnpm@9.1.1',
          dependencies: {
            '@fictjs/compiler': compilerDependency,
            [host.packageName]: nativeDependency,
          },
          pnpm: {
            overrides: {
              ...nativeOverrides,
            },
          },
        },
        null,
        2,
      )}\n`,
    )
    writeConsumers(consumerDirectory)

    run(
      packageManager,
      [
        '--dir',
        consumerDirectory,
        'install',
        '--ignore-scripts',
        '--no-frozen-lockfile',
        '--prefer-offline',
        '--strict-peer-dependencies',
        '--store-dir',
        process.env.FICT_PNPM_STORE_DIR ?? path.join(repositoryRoot, '.pnpm-store'),
      ],
      {
        env: {
          CI: 'true',
          HUSKY: '0',
          CARGO: path.join(tempRoot, 'unavailable-cargo'),
          RUSTC: path.join(tempRoot, 'unavailable-rustc'),
          RUSTUP_HOME: path.join(tempRoot, 'no-rustup'),
        },
      },
    )

    const esm = parseLastJsonLine(
      run(process.execPath, [path.join(consumerDirectory, 'smoke.mjs')], { capture: true }),
    )
    const cjs = parseLastJsonLine(
      run(process.execPath, [path.join(consumerDirectory, 'smoke.cjs')], { capture: true }),
    )
    for (const result of [esm, cjs]) {
      assert.equal(result.info.backend, 'rust')
      assert.equal(result.info.nativeTarget, host.rustTarget)
      assert.equal(result.info.nodeApiVersion, 10)
      assert.equal(result.info.compilerBuildId, result.compilerBuildId)
      assert.equal(
        result.info.compilerCapabilityManifestVersion,
        COMPILER_CAPABILITY_MANIFEST_VERSION,
      )
      assert.match(result.info.compilerCapabilityManifestDigest, /^sha256:[0-9a-f]{64}$/)
      assert.equal(
        result.info.compilerCapabilityPackageVersion,
        nativeBundle.packageManifest.version,
      )
      if (expectedRevision !== null) {
        assert.equal(result.info.compilerBuildRevision, expectedRevision)
      }
    }
    assert.equal(esm.info.compilerBuildId, cjs.info.compilerBuildId)
    assert.equal(esm.info.compilerBuildRevision, cjs.info.compilerBuildRevision)
    assert.equal(
      esm.info.compilerCapabilityManifestDigest,
      cjs.info.compilerCapabilityManifestDigest,
    )

    const replayInvocation = nativeCompilerCorpusReplayInvocation(consumerDirectory)
    const compatibilityCorpus = parseLastJsonLine(
      run(replayInvocation.command, replayInvocation.args, { capture: true }),
    )

    const evidence = {
      schemaVersion: 3,
      target,
      rustTarget: host.rustTarget,
      nodeLane,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      libc: host.libc,
      packageName: host.packageName,
      packageVersion: nativeBundle.packageManifest.version,
      binarySha256: nativeBundle.sha256,
      tarballSha256: nativeBundle.tarballSha256,
      tarballBytes: nativeBundle.buildEvidence.tarballBytes,
      unpackedBytes: nativeBundle.buildEvidence.unpackedBytes,
      sizeGate: nativeBundle.buildEvidence.sizeGate,
      compilerBuildId: esm.info.compilerBuildId,
      compilerBuildRevision: esm.info.compilerBuildRevision,
      compilerCapabilityManifestVersion: esm.info.compilerCapabilityManifestVersion,
      compilerCapabilityManifestDigest: esm.info.compilerCapabilityManifestDigest,
      compilerCapabilityPackageVersion: esm.info.compilerCapabilityPackageVersion,
      compatibilityCorpus,
      formats: [esm.format, cjs.format],
      syncAndAsync: true,
      rustToolchainRequired: false,
    }
    if (options.evidence) {
      const evidencePath = path.resolve(options.evidence)
      mkdirSync(path.dirname(evidencePath), { recursive: true })
      writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
    }
    process.stdout.write(`${JSON.stringify(evidence)}\n`)
  } finally {
    removeNativeSmokeTemporaryDirectory(tempRoot)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(`[native-compiler-package-smoke] ${error.stack ?? error.message ?? error}`)
    process.exitCode = 1
  }
}
