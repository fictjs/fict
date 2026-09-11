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
  process.stderr.write(result.stderr)
}

export const NATIVE_PUBLISH_VISIBILITY_DELAYS_MS = Object.freeze([
  2_000, 4_000, 8_000, 15_000, 30_000, 60_000,
])
// npm scans accepted uploads before making them installable; this can exceed 15 minutes.
export const NATIVE_PUBLISH_VISIBILITY_TIMEOUT_MS = 30 * 60_000
const NATIVE_PUBLISH_REQUEST_TIMEOUT_MS = 30_000

export async function waitForPublishedVersion(
  registry,
  packageName,
  version,
  {
    delaysMs = NATIVE_PUBLISH_VISIBILITY_DELAYS_MS,
    timeoutMs = NATIVE_PUBLISH_VISIBILITY_TIMEOUT_MS,
    requestTimeoutMs = NATIVE_PUBLISH_REQUEST_TIMEOUT_MS,
    fetchImpl = fetch,
    now = Date.now,
    onProgress = message => console.log(message),
    sleep = delay => new Promise(resolve => setTimeout(resolve, delay)),
  } = {},
) {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isSafeInteger(requestTimeoutMs) ||
    requestTimeoutMs <= 0 ||
    delaysMs.length === 0 ||
    delaysMs.some(delay => !Number.isSafeInteger(delay) || delay <= 0)
  ) {
    throw new Error('Publication visibility timeouts and retry delays must be positive integers')
  }

  const startedAt = now()
  const deadline = startedAt + timeoutMs
  let lastObservation = 'version has not been observed'
  for (let attempt = 0; now() < deadline; attempt += 1) {
    let responseStatus
    try {
      const document = await fetchRegistryDocument(registry, packageName, {
        fetchImpl: async (url, options) => {
          const response = await fetchImpl(`${url}?fict-native-publish=${now()}-${attempt}`, {
            ...options,
            headers: { ...options.headers, 'cache-control': 'no-cache' },
            signal: AbortSignal.timeout(Math.min(requestTimeoutMs, Math.max(1, deadline - now()))),
          })
          responseStatus = response.status
          return response
        },
        retryDelaysMs: [],
      })
      if (getPublishedVersions(document).includes(version)) {
        onProgress(
          `[npm-publish] ${packageName}@${version} is visible after ${Math.ceil((now() - startedAt) / 1_000)}s`,
        )
        return
      }
      lastObservation =
        responseStatus === 404
          ? 'registry returned 404'
          : `registry returned ${responseStatus} without version ${version}`
    } catch (error) {
      // Authentication and other permanent client errors will not improve by waiting.
      if (responseStatus >= 400 && responseStatus < 500 && responseStatus !== 429) throw error
      lastObservation = error.message ?? String(error)
    }

    const remainingMs = deadline - now()
    if (remainingMs <= 0) break
    const delay = Math.min(delaysMs[Math.min(attempt, delaysMs.length - 1)], remainingMs)
    onProgress(
      `[npm-publish] Waiting for ${packageName}@${version}: ${lastObservation}; ` +
        `${Math.ceil((now() - startedAt) / 1_000)}s elapsed, retrying in ${Math.ceil(delay / 1_000)}s ` +
        `(limit ${Math.ceil(timeoutMs / 1_000)}s)`,
    )
    await sleep(delay)
  }
  throw new Error(
    `${packageName}@${version} was not visible from ${registry} after publication ` +
      `within ${Math.ceil(timeoutMs / 1_000)}s: ${lastObservation}. ` +
      'npm may still be scanning the accepted upload. Check registry availability before ' +
      'rerunning the original release workflow; do not replace the tag or republish different bytes.',
  )
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
      requireAttestations: true,
      verifySbomClosure: true,
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
