#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  NATIVE_COMPILER_TARGETS,
  nativeArtifactName,
  verifyNativeBundle,
} from './native-compiler-packages.mjs'
import { fetchRegistryDocument, getPublishedVersions } from './release-publish-plan.mjs'

export function validateNativePublishPlan(plan) {
  const failures = []
  const entries = new Map((plan.packages ?? []).map(entry => [entry.name, entry]))
  const facade = entries.get('@fictjs/compiler')
  if (!facade) return ['release plan is missing @fictjs/compiler']
  const publishOrder = plan.publishOrder ?? []
  const facadeIndex = publishOrder.indexOf('@fictjs/compiler')

  for (const target of NATIVE_COMPILER_TARGETS) {
    const entry = entries.get(target.packageName)
    if (!entry) {
      failures.push(`release plan is missing ${target.packageName}`)
      continue
    }
    if (entry.version !== facade.version) {
      failures.push(
        `${target.packageName}@${entry.version} does not match facade ${facade.version}`,
      )
    }
    const nativeIndex = publishOrder.indexOf(target.packageName)
    if (nativeIndex < 0 || facadeIndex < 0 || nativeIndex > facadeIndex) {
      failures.push(`${target.packageName} must precede @fictjs/compiler in publishOrder`)
    }
    if (facade.status === 'already-published' && entry.status !== 'already-published') {
      failures.push(`facade ${facade.version} is already published without ${target.packageName}`)
    }
  }
  return failures
}

export function collectNativePublishActions(plan) {
  const entries = new Map((plan.packages ?? []).map(entry => [entry.name, entry]))
  return NATIVE_COMPILER_TARGETS.map(target => ({ target, entry: entries.get(target.packageName) }))
    .filter(action => action.entry?.status !== 'already-published')
    .map(action => ({
      packageName: action.target.packageName,
      target: action.target.target,
      version: action.entry.version,
      status: action.entry.status,
    }))
}

function parseArguments(args) {
  const options = { verifyOnly: false }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--verify-only') {
      options.verifyOnly = true
      continue
    }
    const value = args[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`)
    index += 1
    if (argument === '--plan') options.planPath = path.resolve(value)
    else if (argument === '--artifacts') options.artifactsRoot = path.resolve(value)
    else throw new Error(`Unknown argument: ${argument}`)
  }
  if (!options.planPath || !options.artifactsRoot) {
    throw new Error('--plan and --artifacts are required')
  }
  return options
}

export function publishTarball(tarballPath) {
  const result = spawnSync('npm', ['publish', tarballPath, '--access', 'public', '--provenance'], {
    encoding: 'utf8',
    env: { ...process.env, NPM_CONFIG_PROVENANCE: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`npm publish failed for ${tarballPath}:\n${result.stdout}${result.stderr}`)
  }
  process.stdout.write(result.stdout)
}

export async function waitForPublishedVersion(registry, packageName, version) {
  const delays = [2_000, 4_000, 8_000, 15_000, 30_000]
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    const document = await fetchRegistryDocument(registry, packageName, {
      fetchImpl: (url, options) =>
        fetch(`${url}?fict-native-publish=${Date.now()}-${attempt}`, {
          ...options,
          headers: { ...options.headers, 'cache-control': 'no-cache' },
        }),
      retryDelaysMs: [],
    })
    if (getPublishedVersions(document).includes(version)) return
    if (attempt < delays.length) {
      await new Promise(resolve => setTimeout(resolve, delays[attempt]))
    }
  }
  throw new Error(`${packageName}@${version} was not visible from ${registry} after publication`)
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const plan = JSON.parse(readFileSync(options.planPath, 'utf8'))
  const failures = validateNativePublishPlan(plan)
  if (failures.length > 0) {
    throw new Error(`Invalid atomic native publish plan:\n- ${failures.join('\n- ')}`)
  }

  const bundles = new Map()
  for (const target of NATIVE_COMPILER_TARGETS) {
    const bundle = verifyNativeBundle({
      target: target.target,
      bundleDirectory: path.join(options.artifactsRoot, nativeArtifactName(target.target)),
    })
    const planEntry = plan.packages.find(entry => entry.name === target.packageName)
    if (bundle.packageManifest.version !== planEntry.version) {
      throw new Error(
        `${target.packageName} artifact version ${bundle.packageManifest.version} ` +
          `does not match release plan ${planEntry.version}`,
      )
    }
    bundles.set(target.target, bundle)
  }

  const actions = collectNativePublishActions(plan)
  const summary = {
    schemaVersion: 1,
    facadeVersion: plan.packages.find(entry => entry.name === '@fictjs/compiler').version,
    verifiedTargets: NATIVE_COMPILER_TARGETS.map(target => target.target),
    publishActions: actions,
  }
  if (options.verifyOnly) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
    return
  }

  for (const action of actions) {
    const bundle = bundles.get(action.target)
    publishTarball(bundle.tarballPath)
    await waitForPublishedVersion(plan.registry, action.packageName, action.version)
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`[publish-native-compiler-packages] ${error.stack ?? error.message ?? error}`)
    process.exitCode = 1
  })
}
