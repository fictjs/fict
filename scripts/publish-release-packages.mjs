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

import {
  NATIVE_COMPILER_TARGETS,
  nativeArtifactName,
  nativeHostTarget,
  repositoryRoot,
  verifyNativeBundle,
} from './native-compiler-packages.mjs'
import {
  collectExportTargets,
  findNativeCompilerVersionMismatches,
  findWorkspaceProtocols,
} from './package-tarball-smoke.mjs'
import {
  publishTarball,
  validateNativePublishPlan,
  waitForPublishedVersion,
} from './publish-native-compiler-packages.mjs'

const packageManager = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

function verifyPreparedCompilerTarball(prepared, nativeArtifactsRoot, outputDirectory) {
  const compiler = prepared.artifacts.find(artifact => artifact.name === '@fictjs/compiler')
  if (!compiler || compiler.status === 'already-published') return
  if (!compiler.tarball) throw new Error('Prepared compiler facade tarball is missing')
  const target = nativeHostTarget()
  run(process.execPath, [
    path.join(repositoryRoot, 'scripts/native-compiler-package-smoke.mjs'),
    '--bundle',
    path.join(nativeArtifactsRoot, nativeArtifactName(target)),
    '--target',
    target,
    '--compiler-tarball',
    path.join(outputDirectory, compiler.tarball),
  ])
}

function hashFile(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
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

function archiveManifest(tarballPath) {
  return JSON.parse(run('tar', ['-xOf', tarballPath, 'package/package.json']))
}

function archiveEntries(tarballPath) {
  return new Set(
    run('tar', ['-tzf', tarballPath])
      .split(/\r?\n/)
      .filter(Boolean)
      .map(entry => entry.replace(/^package\//, '').replace(/\/$/, '')),
  )
}

function packageManifests(plan) {
  return new Map(
    plan.packages.map(entry => {
      const manifestPath = path.join(repositoryRoot, entry.path, 'package.json')
      return [entry.name, readJson(manifestPath)]
    }),
  )
}

export function validateReleasePublishPlan(plan, manifests) {
  const failures = [...validateNativePublishPlan(plan)]
  const packageNames = new Set((plan.packages ?? []).map(entry => entry.name))
  const order = plan.publishOrder ?? []
  const orderSet = new Set(order)
  if (order.length !== packageNames.size || orderSet.size !== packageNames.size) {
    failures.push('publishOrder must contain every release package exactly once')
  }
  for (const packageName of packageNames) {
    if (!orderSet.has(packageName)) failures.push(`publishOrder is missing ${packageName}`)
  }

  const positions = new Map(order.map((name, index) => [name, index]))
  for (const [packageName, manifest] of manifests) {
    const packageIndex = positions.get(packageName)
    for (const dependencyName of [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
    ]) {
      if (!packageNames.has(dependencyName)) continue
      const dependencyIndex = positions.get(dependencyName)
      if (dependencyIndex >= packageIndex) {
        failures.push(`${dependencyName} must publish before dependent ${packageName}`)
      }
    }
  }
  return failures
}

function validatePackedArchive(entry, tarballPath) {
  const manifest = archiveManifest(tarballPath)
  if (manifest.name !== entry.name || manifest.version !== entry.version) {
    throw new Error(
      `${path.basename(tarballPath)} is ${manifest.name}@${manifest.version}; ` +
        `expected ${entry.name}@${entry.version}`,
    )
  }
  const workspaceProtocols = findWorkspaceProtocols(manifest)
  if (workspaceProtocols.length > 0) {
    throw new Error(`${entry.name} retained workspace protocols: ${workspaceProtocols.join(', ')}`)
  }
  const nativeVersionMismatches = findNativeCompilerVersionMismatches(manifest)
  if (nativeVersionMismatches.length > 0) {
    throw new Error(
      `${entry.name} native versions do not match ${entry.version}: ` +
        nativeVersionMismatches.join(', '),
    )
  }
  const entries = archiveEntries(tarballPath)
  const missing = collectExportTargets(manifest.exports).filter(target => !entries.has(target))
  if (missing.length > 0) {
    throw new Error(`${entry.name} tarball is missing exports: ${missing.join(', ')}`)
  }
  return manifest
}

function packWorkspacePackage(entry, outputDirectory) {
  const before = new Set(readdirSync(outputDirectory))
  run(packageManager, [
    '--dir',
    path.join(repositoryRoot, entry.path),
    'pack',
    '--pack-destination',
    outputDirectory,
  ])
  const created = readdirSync(outputDirectory).filter(
    file => file.endsWith('.tgz') && !before.has(file),
  )
  if (created.length !== 1) {
    throw new Error(`${entry.name} produced ${created.length} release tarballs`)
  }
  const tarballPath = path.join(outputDirectory, created[0])
  validatePackedArchive(entry, tarballPath)
  return tarballPath
}

function copyNativeTarball(bundle, outputDirectory) {
  const tarballPath = path.join(outputDirectory, path.basename(bundle.tarballPath))
  copyFileSync(bundle.tarballPath, tarballPath)
  return { bundle, tarballPath }
}

function planFingerprint(plan) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        registry: plan.registry,
        packages: plan.packages,
        publishOrder: plan.publishOrder,
      }),
    )
    .digest('hex')
}

export function prepareReleaseArtifacts({ plan, nativeArtifactsRoot, outputDirectory }) {
  const manifests = packageManifests(plan)
  const failures = validateReleasePublishPlan(plan, manifests)
  if (failures.length > 0) {
    throw new Error(`Invalid release publish plan:\n- ${failures.join('\n- ')}`)
  }

  const destination = path.resolve(outputDirectory)
  rmSync(destination, { recursive: true, force: true })
  mkdirSync(destination, { recursive: true })
  const nativeByName = new Map(NATIVE_COMPILER_TARGETS.map(target => [target.packageName, target]))
  const nativeBundles = new Map(
    NATIVE_COMPILER_TARGETS.map(target => [
      target.target,
      verifyNativeBundle({
        target: target.target,
        bundleDirectory: path.join(nativeArtifactsRoot, nativeArtifactName(target.target)),
      }),
    ]),
  )
  const entriesByName = new Map(plan.packages.map(entry => [entry.name, entry]))
  const artifacts = []

  for (const packageName of plan.publishOrder) {
    const entry = entriesByName.get(packageName)
    if (entry.status === 'already-published') {
      artifacts.push({ ...entry, tarball: null, sha256: null, bytes: null })
      continue
    }

    const nativeTarget = nativeByName.get(packageName)
    let tarballPath
    if (nativeTarget) {
      const native = copyNativeTarball(nativeBundles.get(nativeTarget.target), destination)
      if (native.bundle.packageManifest.version !== entry.version) {
        throw new Error(
          `${packageName} native artifact ${native.bundle.packageManifest.version} ` +
            `does not match plan ${entry.version}`,
        )
      }
      tarballPath = native.tarballPath
    } else {
      tarballPath = packWorkspacePackage(entry, destination)
    }
    const sha256 = hashFile(tarballPath)
    writeFileSync(`${tarballPath}.sha256`, `${sha256}  ${path.basename(tarballPath)}\n`)
    artifacts.push({
      ...entry,
      tarball: path.basename(tarballPath),
      sha256,
      bytes: statSync(tarballPath).size,
    })
  }

  const releaseArtifacts = {
    schemaVersion: 1,
    planFingerprint: planFingerprint(plan),
    registry: plan.registry,
    artifacts,
  }
  writeFileSync(
    path.join(destination, 'release-artifacts.json'),
    `${JSON.stringify(releaseArtifacts, null, 2)}\n`,
  )
  return releaseArtifacts
}

function verifyPreparedArtifacts(plan, outputDirectory) {
  const releaseArtifacts = readJson(path.join(outputDirectory, 'release-artifacts.json'))
  if (
    releaseArtifacts.schemaVersion !== 1 ||
    releaseArtifacts.planFingerprint !== planFingerprint(plan) ||
    releaseArtifacts.registry !== plan.registry
  ) {
    throw new Error('Prepared release artifacts do not match the current release plan')
  }
  for (const artifact of releaseArtifacts.artifacts) {
    if (artifact.status === 'already-published') continue
    const tarballPath = path.join(outputDirectory, artifact.tarball)
    if (!existsSync(tarballPath) || hashFile(tarballPath) !== artifact.sha256) {
      throw new Error(`${artifact.name} prepared tarball is missing or corrupt`)
    }
    const checksum = readFileSync(`${tarballPath}.sha256`, 'utf8')
    if (checksum !== `${artifact.sha256}  ${artifact.tarball}\n`) {
      throw new Error(`${artifact.name} prepared checksum is missing or corrupt`)
    }
  }
  return releaseArtifacts
}

async function publishPreparedArtifacts(plan, outputDirectory) {
  const prepared = verifyPreparedArtifacts(plan, outputDirectory)
  for (const artifact of prepared.artifacts) {
    if (artifact.status === 'already-published') continue
    publishTarball(path.join(outputDirectory, artifact.tarball))
    await waitForPublishedVersion(plan.registry, artifact.name, artifact.version)
  }
  return prepared
}

function parseArguments(args) {
  const options = { publish: false }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--publish') {
      options.publish = true
      continue
    }
    const value = args[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`)
    index += 1
    if (argument === '--plan') options.planPath = path.resolve(value)
    else if (argument === '--native-artifacts') options.nativeArtifactsRoot = path.resolve(value)
    else if (argument === '--output') options.outputDirectory = path.resolve(value)
    else throw new Error(`Unknown argument: ${argument}`)
  }
  if (!options.planPath || !options.nativeArtifactsRoot || !options.outputDirectory) {
    throw new Error('--plan, --native-artifacts, and --output are required')
  }
  return options
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const plan = readJson(options.planPath)
  const prepared = prepareReleaseArtifacts({
    plan,
    nativeArtifactsRoot: options.nativeArtifactsRoot,
    outputDirectory: options.outputDirectory,
  })
  verifyPreparedCompilerTarball(prepared, options.nativeArtifactsRoot, options.outputDirectory)
  if (options.publish) await publishPreparedArtifacts(plan, options.outputDirectory)
  process.stdout.write(`${JSON.stringify(prepared, null, 2)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`[publish-release-packages] ${error.stack ?? error.message ?? error}`)
    process.exitCode = 1
  })
}
