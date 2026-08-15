#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { validateNativeBootstrapCertification } from './bootstrap-native-compiler-packages.mjs'
import { compilerCorpusIdentity } from './lib/compiler-corpus-replay.mjs'
import {
  NATIVE_COMPILER_TARGETS,
  nativeArtifactName,
  verifyNativeBundle,
} from './native-compiler-packages.mjs'

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const GIT_REVISION = /^[0-9a-f]{40}$/

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

function capabilityIdentity(manifest) {
  return {
    version: manifest.schemaVersion,
    digest: `sha256:${createHash('sha256').update(JSON.stringify(manifest)).digest('hex')}`,
    packageVersion: manifest.packageVersion,
  }
}

export function validateCompilerReleaseUnit({
  plan,
  certification,
  revision,
  tagRevision,
  corpusIdentity,
  capabilityIdentity: expectedCapability,
  reviewedRevisionIsAncestor,
}) {
  const failures = []
  const compilerEntries = Array.isArray(plan?.packages)
    ? plan.packages.filter(entry => entry?.name === '@fictjs/compiler')
    : []
  const compiler = compilerEntries[0]
  if (compilerEntries.length !== 1 || typeof compiler?.version !== 'string') {
    failures.push('release plan must contain exactly one @fictjs/compiler package')
  } else {
    if (plan.tag !== `v${compiler.version}`) {
      failures.push(`release plan tag ${String(plan.tag)} does not match v${compiler.version}`)
    }
    if (certification?.packageVersion !== compiler.version) {
      failures.push('native certification package version does not match the release plan')
    }
    if (expectedCapability?.packageVersion !== compiler.version) {
      failures.push('compiler capability manifest package version does not match the release plan')
    }
  }

  if (!GIT_REVISION.test(revision ?? '') || tagRevision !== revision) {
    failures.push('release tag revision does not match the certified checkout revision')
  }
  if (certification?.schemaVersion !== 4) {
    failures.push(
      'release requires native certification schema v4 with SBOM and artifact attestations',
    )
  }
  if (certification?.compilerBuildRevision !== revision) {
    failures.push('native certification build revision does not match the release revision')
  }
  if (
    certification?.compilerCapabilityManifestVersion !== expectedCapability?.version ||
    certification?.compilerCapabilityManifestDigest !== expectedCapability?.digest ||
    certification?.compilerCapabilityPackageVersion !== expectedCapability?.packageVersion
  ) {
    failures.push('native certification does not match the compiler capability manifest')
  }
  if (JSON.stringify(certification?.compatibilityCorpus) !== JSON.stringify(corpusIdentity)) {
    failures.push('native certification did not replay the exact frozen compiler corpus')
  }
  if (reviewedRevisionIsAncestor !== true) {
    failures.push('frozen compiler corpus reviewed revision is not an ancestor of the release')
  }

  return failures
}

function parseArguments(args) {
  const options = {}
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    const value = args[index + 1]
    if (!argument.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`${argument} requires a value`)
    }
    const name = argument.slice(2)
    options[name] = name === 'revision' ? value : path.resolve(value)
    index += 1
  }
  for (const name of ['plan', 'certification', 'artifacts', 'revision']) {
    if (!options[name]) throw new Error(`--${name} is required`)
  }
  return options
}

function git(args) {
  const result = spawnSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return result
}

function main() {
  const options = parseArguments(process.argv.slice(2))
  const revision = options.revision
  if (!GIT_REVISION.test(revision)) {
    throw new Error('--revision must be a lowercase 40-character Git SHA-1')
  }
  const plan = readJson(options.plan)
  const certification = readJson(options.certification)
  const bundles = new Map(
    NATIVE_COMPILER_TARGETS.map(target => [
      target.target,
      verifyNativeBundle({
        target: target.target,
        bundleDirectory: path.join(options.artifacts, nativeArtifactName(target.target)),
        requireAttestations: true,
        verifySbomClosure: true,
      }),
    ]),
  )
  validateNativeBootstrapCertification(certification, bundles, revision)

  const corpusPath =
    options.corpus ??
    path.join(repositoryRoot, 'crates/fict-compiler/tests/rust_frozen_codegen_corpus.json')
  const corpusSource = readFileSync(corpusPath, 'utf8')
  const corpus = compilerCorpusIdentity(JSON.parse(corpusSource), corpusSource)
  const capabilityPath =
    options.capabilities ??
    path.join(repositoryRoot, 'packages/compiler/compiler-capabilities.json')
  const capability = capabilityIdentity(readJson(capabilityPath))

  const tagRevisionResult = git(['rev-list', '-n', '1', String(plan.tag ?? '')])
  const tagRevision = tagRevisionResult.status === 0 ? tagRevisionResult.stdout.trim() : null
  const ancestorResult = git(['merge-base', '--is-ancestor', corpus.reviewedRevision, revision])
  const failures = validateCompilerReleaseUnit({
    plan,
    certification,
    revision,
    tagRevision,
    corpusIdentity: corpus,
    capabilityIdentity: capability,
    reviewedRevisionIsAncestor: ancestorResult.status === 0,
  })
  if (failures.length > 0) {
    throw new Error(`Invalid compiler release unit:\n- ${failures.join('\n- ')}`)
  }
  process.stdout.write(
    `${JSON.stringify({ packageVersion: capability.packageVersion, revision, tag: plan.tag, corpus })}\n`,
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(`[verify-compiler-release-unit] ${error.stack ?? error.message ?? error}`)
    process.exitCode = 1
  }
}
