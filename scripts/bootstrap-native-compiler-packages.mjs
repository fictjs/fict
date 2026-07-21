#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  COMPILER_CAPABILITY_MANIFEST_VERSION,
  NATIVE_COMPILER_NODE_LANES,
  NATIVE_COMPILER_TARGETS,
  nativeArtifactName,
  nativeNodeVersionMatchesLane,
  verifyNativeBundle,
} from './native-compiler-packages.mjs'
import {
  fetchRegistryDocument,
  getPublishedVersions,
  normalizeRegistryDocument,
} from './release-publish-plan.mjs'
import { waitForPublishedVersion } from './publish-native-compiler-packages.mjs'

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const releaseConfigPath = path.join(repositoryRoot, '.github/npm-publish-packages.json')
const GIT_REVISION = /^[0-9a-f]{40}$/

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function bundleIdentity(bundle) {
  return {
    packageVersion: bundle.packageManifest.version,
    binarySha256: bundle.sha256,
    tarballSha256: bundle.tarballSha256,
    tarballBytes: bundle.buildEvidence.tarballBytes,
    unpackedBytes: bundle.buildEvidence.unpackedBytes,
    sizeGate: bundle.buildEvidence.sizeGate,
  }
}

export function validateNativeBootstrapCertification(certification, bundles, expectedRevision) {
  if (!isRecord(certification)) throw new TypeError('native certification must be an object')
  if (!(bundles instanceof Map) || bundles.size !== NATIVE_COMPILER_TARGETS.length) {
    throw new TypeError('native bootstrap requires exactly eight verified bundles')
  }
  if (!GIT_REVISION.test(expectedRevision ?? '')) {
    throw new TypeError('expected revision must be a lowercase 40-character Git SHA-1')
  }

  const { certificationDigest, ...payload } = certification
  const expectedPairs = NATIVE_COMPILER_TARGETS.flatMap(target =>
    NATIVE_COMPILER_NODE_LANES.map(nodeLane => `${target.target}:node-${nodeLane}`),
  )
  const failures = []
  const computedDigest = `sha256:${createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex')}`

  if (![2, 3].includes(payload.schemaVersion) || payload.status !== 'pass') {
    failures.push('certification must be a passing schema v2 or v3 record')
  }
  if (
    payload.targets !== NATIVE_COMPILER_TARGETS.length ||
    payload.certifications !== expectedPairs.length ||
    payload.bundles !== NATIVE_COMPILER_TARGETS.length ||
    JSON.stringify(payload.nodeLanes) !== JSON.stringify(NATIVE_COMPILER_NODE_LANES) ||
    JSON.stringify(payload.certifiedPairs) !== JSON.stringify(expectedPairs)
  ) {
    failures.push('certification does not cover the exact 8-target by 2-Node matrix')
  }
  if (
    payload.compilerBuildRevision !== expectedRevision ||
    typeof payload.compilerBuildId !== 'string' ||
    !payload.compilerBuildId
  ) {
    failures.push('certification does not bind the expected compiler build revision')
  }
  if (
    payload.schemaVersion === 3 &&
    (payload.compilerCapabilityManifestVersion !== COMPILER_CAPABILITY_MANIFEST_VERSION ||
      !/^sha256:[0-9a-f]{64}$/.test(payload.compilerCapabilityManifestDigest ?? '') ||
      payload.compilerCapabilityPackageVersion !== payload.packageVersion)
  ) {
    failures.push('certification does not bind one compiler capability manifest')
  }
  if (
    payload.schemaVersion === 3 &&
    (payload.compatibilityCorpus?.schemaVersion !== 1 ||
      payload.compatibilityCorpus.corpusSchemaVersion !== 5 ||
      !/^sha256:[0-9a-f]{64}$/.test(payload.compatibilityCorpus.corpusSha256 ?? '') ||
      !Number.isSafeInteger(payload.compatibilityCorpus.fixtures) ||
      payload.compatibilityCorpus.fixtures <= 0 ||
      !GIT_REVISION.test(payload.compatibilityCorpus.reviewedRevision ?? '') ||
      typeof payload.compatibilityCorpus.reviewedCompilerBuildId !== 'string' ||
      !payload.compatibilityCorpus.reviewedCompilerBuildId)
  ) {
    failures.push('certification does not bind a replayed compatibility corpus')
  }
  if (certificationDigest !== computedDigest) {
    failures.push('certification digest does not match its payload')
  }

  if (!Array.isArray(payload.runtimeEvidence) || payload.runtimeEvidence.length !== 16) {
    failures.push('certification must contain exactly 16 runtime evidence records')
  } else {
    for (const [index, pair] of expectedPairs.entries()) {
      const evidence = payload.runtimeEvidence[index]
      const [target, nodeLane] = pair.split(':node-')
      if (
        !isRecord(evidence) ||
        evidence.pair !== pair ||
        evidence.target !== target ||
        evidence.nodeLane !== nodeLane ||
        !nativeNodeVersionMatchesLane(evidence.node, nodeLane) ||
        !/^sha256:[0-9a-f]{64}$/.test(evidence.evidenceDigest ?? '')
      ) {
        failures.push(`runtime evidence ${pair} is incomplete or out of order`)
      }
    }
  }

  if (!Array.isArray(payload.releaseBundles) || payload.releaseBundles.length !== 8) {
    failures.push('certification must contain exactly eight release bundle identities')
  } else {
    for (const [index, target] of NATIVE_COMPILER_TARGETS.entries()) {
      const certified = payload.releaseBundles[index]
      const bundle = bundles.get(target.target)
      if (!bundle) {
        failures.push(`verified bundle is missing ${target.target}`)
        continue
      }
      const expected = { target: target.target, ...bundleIdentity(bundle) }
      if (JSON.stringify(certified) !== JSON.stringify(expected)) {
        failures.push(`certified identity does not match ${target.target} bundle`)
      }
    }
  }

  if (typeof payload.packageVersion !== 'string' || !payload.packageVersion) {
    failures.push('certification package version is missing')
  } else {
    for (const [target, bundle] of bundles) {
      if (bundle.packageManifest.version !== payload.packageVersion) {
        failures.push(`${target} bundle version does not match certification`)
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(`Invalid native bootstrap certification:\n- ${failures.join('\n- ')}`)
  }
  return {
    packageVersion: payload.packageVersion,
    compilerBuildId: payload.compilerBuildId,
    compilerBuildRevision: payload.compilerBuildRevision,
    certificationDigest,
  }
}

function publishedIntegrity(document, version) {
  const normalized = normalizeRegistryDocument(document)
  const versions = normalized?.versions
  if (!isRecord(versions) || !isRecord(versions[version])) return null
  const integrity = versions[version].dist?.integrity
  return typeof integrity === 'string' && integrity ? integrity : null
}

export function classifyNativeBootstrapRegistry({
  certification,
  bundles,
  facadeDocument,
  nativeDocuments,
}) {
  const version = certification.packageVersion
  if (!getPublishedVersions(facadeDocument).includes(version)) {
    throw new Error(
      `@fictjs/compiler@${version} must already be published before native package bootstrap`,
    )
  }
  if (!(nativeDocuments instanceof Map)) {
    throw new TypeError('native registry documents must be a Map')
  }
  if (
    nativeDocuments.size !== NATIVE_COMPILER_TARGETS.length ||
    NATIVE_COMPILER_TARGETS.some(target => !nativeDocuments.has(target.packageName))
  ) {
    throw new TypeError('native registry state must contain exactly eight package names')
  }

  return NATIVE_COMPILER_TARGETS.map(target => {
    const document = nativeDocuments.get(target.packageName)
    const normalized = normalizeRegistryDocument(document)
    const bundle = bundles.get(target.target)
    if (normalized !== null && normalized.name !== target.packageName) {
      throw new Error(`registry document for ${target.packageName} has the wrong package name`)
    }
    const versions = getPublishedVersions(normalized)
    if (versions.includes(version)) {
      const integrity = publishedIntegrity(normalized, version)
      if (integrity !== bundle.buildEvidence.npmIntegrity) {
        throw new Error(`${target.packageName}@${version} registry integrity does not match bundle`)
      }
      return { packageName: target.packageName, target: target.target, status: 'verified' }
    }
    if (normalized !== null) {
      return { packageName: target.packageName, target: target.target, status: 'existing' }
    }
    return { packageName: target.packageName, target: target.target, status: 'new-package' }
  })
}

export function nativeBootstrapPublishArgs(tarballPath) {
  return ['publish', tarballPath, '--access', 'public', '--provenance=false']
}

export function nativeTrustedPublisherArgs(packageName) {
  return [
    'trust',
    'github',
    packageName,
    '--file',
    'release.yml',
    '--repo',
    'fictjs/fict',
    '--allow-publish',
  ]
}

export function nativeBootstrapNpmStdio(interactive = false) {
  return interactive ? 'inherit' : ['ignore', 'pipe', 'pipe']
}

function runNpm(args, { provenance, interactive = false } = {}) {
  const result = spawnSync('npm', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...(provenance === false ? { NPM_CONFIG_PROVENANCE: 'false' } : {}),
    },
    stdio: nativeBootstrapNpmStdio(interactive),
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const output = interactive ? '' : `:\n${result.stdout}${result.stderr}`
    throw new Error(`npm ${args.join(' ')} failed${output}`)
  }
  return interactive ? '' : result.stdout.trim()
}

function assertBootstrapToolchain() {
  const version = runNpm(['--version'])
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match || Number(match[1]) < 11 || (Number(match[1]) === 11 && Number(match[2]) < 15)) {
    throw new Error(`native bootstrap requires npm >=11.15.0; found ${version}`)
  }
  const reviewer = runNpm(['whoami'])
  if (!reviewer) throw new Error('native bootstrap requires an authenticated npm maintainer')
  return { npmVersion: version, npmUser: reviewer }
}

export function parseNativeBootstrapArguments(args) {
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
    if (argument === '--artifacts') options.artifactsRoot = path.resolve(value)
    else if (argument === '--certification') options.certificationPath = path.resolve(value)
    else if (argument === '--expected-revision') options.expectedRevision = value
    else throw new Error(`Unknown argument: ${argument}`)
  }
  const missingArguments = [
    ['artifactsRoot', '--artifacts'],
    ['certificationPath', '--certification'],
    ['expectedRevision', '--expected-revision'],
  ]
    .filter(([field]) => !options[field])
    .map(([, argument]) => argument)
  if (missingArguments.length > 0) {
    throw new Error(
      `${missingArguments.join(', ')} ${missingArguments.length === 1 ? 'is' : 'are'} required`,
    )
  }
  return options
}

async function readRegistryState(registry, packageVersion) {
  const [facadeDocument, entries] = await Promise.all([
    fetchRegistryDocument(registry, '@fictjs/compiler'),
    Promise.all(
      NATIVE_COMPILER_TARGETS.map(async target => [
        target.packageName,
        await fetchRegistryDocument(registry, target.packageName),
      ]),
    ),
  ])
  if (!getPublishedVersions(facadeDocument).includes(packageVersion)) {
    throw new Error(`@fictjs/compiler@${packageVersion} is not visible from ${registry}`)
  }
  return { facadeDocument, nativeDocuments: new Map(entries) }
}

async function main() {
  const options = parseNativeBootstrapArguments(process.argv.slice(2))
  const releaseConfig = JSON.parse(readFileSync(releaseConfigPath, 'utf8'))
  const certification = JSON.parse(readFileSync(options.certificationPath, 'utf8'))
  const bundles = new Map(
    NATIVE_COMPILER_TARGETS.map(target => [
      target.target,
      verifyNativeBundle({
        target: target.target,
        bundleDirectory: path.join(options.artifactsRoot, nativeArtifactName(target.target)),
      }),
    ]),
  )
  const certified = validateNativeBootstrapCertification(
    certification,
    bundles,
    options.expectedRevision,
  )
  const registryState = await readRegistryState(releaseConfig.registry, certified.packageVersion)
  let actions = classifyNativeBootstrapRegistry({
    certification: certified,
    bundles,
    ...registryState,
  })

  if (!options.publish) {
    process.stdout.write(`${JSON.stringify({ ...certified, publish: false, actions }, null, 2)}\n`)
    return
  }

  const toolchain = assertBootstrapToolchain()
  for (const action of actions.filter(action => action.status === 'new-package')) {
    const bundle = bundles.get(action.target)
    runNpm(nativeBootstrapPublishArgs(bundle.tarballPath), {
      provenance: false,
      interactive: true,
    })
    await waitForPublishedVersion(
      releaseConfig.registry,
      action.packageName,
      certified.packageVersion,
    )
  }

  const finalRegistryState = await readRegistryState(
    releaseConfig.registry,
    certified.packageVersion,
  )
  actions = classifyNativeBootstrapRegistry({
    certification: certified,
    bundles,
    ...finalRegistryState,
  })
  if (actions.some(action => action.status === 'new-package')) {
    throw new Error('native package bootstrap did not create all eight package names')
  }
  for (const target of NATIVE_COMPILER_TARGETS) {
    runNpm(nativeTrustedPublisherArgs(target.packageName), { interactive: true })
  }
  process.stdout.write(
    `${JSON.stringify({ ...certified, publish: true, toolchain, actions }, null, 2)}\n`,
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`[bootstrap-native-compiler-packages] ${error.stack ?? error.message ?? error}`)
    process.exitCode = 1
  })
}
