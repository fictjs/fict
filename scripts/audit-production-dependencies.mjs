#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const releaseConfigPath = path.join(repositoryRoot, '.github/npm-publish-packages.json')
const packageManager = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const SEVERITY = Object.freeze({ info: 0, low: 1, moderate: 2, high: 3, critical: 4 })
const DEFAULT_RETRY_DELAYS_MS = Object.freeze([1_000, 2_000, 4_000])

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function collectProductionVersions(projects) {
  if (!Array.isArray(projects))
    throw new TypeError('pnpm production dependency graph must be an array')
  const versions = new Map()

  function visit(node) {
    if (!isRecord(node)) return
    for (const [name, dependency] of Object.entries(node.dependencies ?? {})) {
      if (!isRecord(dependency)) {
        throw new TypeError(`pnpm dependency ${name} must be an object`)
      }
      if (typeof dependency.version !== 'string' || !dependency.version) {
        throw new TypeError(`pnpm dependency ${name} is missing an auditable version`)
      }
      if (SEMVER.test(dependency.version)) {
        const packageVersions = versions.get(name) ?? new Set()
        packageVersions.add(dependency.version)
        versions.set(name, packageVersions)
      } else if (!dependency.version.startsWith('link:')) {
        throw new TypeError(
          `pnpm dependency ${name} has unsupported non-registry version ${dependency.version}`,
        )
      }
      visit(dependency)
    }
  }

  for (const project of projects) visit(project)
  return Object.fromEntries(
    [...versions]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, packageVersions]) => [name, [...packageVersions].sort()]),
  )
}

export function parseBulkAdvisories(value, requestedPackages) {
  if (!isRecord(value)) throw new TypeError('npm bulk advisory response must be an object')
  const requested = new Set(Object.keys(requestedPackages))
  const advisories = []

  for (const [packageName, entries] of Object.entries(value)) {
    if (!requested.has(packageName)) {
      throw new Error(`npm bulk advisory response contains unrequested package ${packageName}`)
    }
    if (!Array.isArray(entries)) {
      throw new TypeError(`npm bulk advisory response for ${packageName} must be an array`)
    }
    for (const entry of entries) {
      if (
        !isRecord(entry) ||
        !['string', 'number'].includes(typeof entry.id) ||
        String(entry.id).length === 0 ||
        typeof entry.title !== 'string' ||
        !entry.title ||
        typeof entry.url !== 'string' ||
        !entry.url.startsWith('https://') ||
        typeof entry.vulnerable_versions !== 'string' ||
        !Object.hasOwn(SEVERITY, entry.severity)
      ) {
        throw new Error(`npm bulk advisory response for ${packageName} is malformed`)
      }
      advisories.push({
        packageName,
        id: entry.id,
        severity: entry.severity,
        title: entry.title,
        url: entry.url,
        vulnerableVersions: entry.vulnerable_versions,
      })
    }
  }

  return advisories.sort(
    (left, right) =>
      SEVERITY[right.severity] - SEVERITY[left.severity] ||
      left.packageName.localeCompare(right.packageName) ||
      String(left.id).localeCompare(String(right.id)),
  )
}

export function advisoriesAtOrAbove(advisories, auditLevel = 'low') {
  if (!Object.hasOwn(SEVERITY, auditLevel)) {
    throw new TypeError(`Unsupported audit level: ${auditLevel}`)
  }
  return advisories.filter(advisory => SEVERITY[advisory.severity] >= SEVERITY[auditLevel])
}

export async function fetchBulkAdvisories({
  registry,
  packages,
  fetchImpl = fetch,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  sleep = delay => new Promise(resolve => setTimeout(resolve, delay)),
}) {
  if (typeof registry !== 'string' || !registry.startsWith('https://')) {
    throw new TypeError('npm registry must be an HTTPS URL')
  }
  if (!isRecord(packages) || Object.keys(packages).length === 0) {
    throw new TypeError('production dependency audit requires at least one registry package')
  }
  for (const [packageName, versions] of Object.entries(packages)) {
    if (
      !packageName ||
      !Array.isArray(versions) ||
      versions.length === 0 ||
      versions.some(version => typeof version !== 'string' || !SEMVER.test(version))
    ) {
      throw new TypeError(
        `production dependency versions for ${packageName || '<empty>'} are invalid`,
      )
    }
  }
  const endpoint = `${registry.replace(/\/$/, '')}/-/npm/v1/security/advisories/bulk`

  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    let response
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(packages),
      })
    } catch (error) {
      if (attempt === retryDelaysMs.length) {
        throw new Error(`npm bulk advisory request failed: ${error.message}`, { cause: error })
      }
      await sleep(retryDelaysMs[attempt])
      continue
    }

    if (response.ok) {
      let body
      try {
        body = await response.json()
      } catch (error) {
        throw new Error(`npm bulk advisory response is not valid JSON: ${error.message}`, {
          cause: error,
        })
      }
      return parseBulkAdvisories(body, packages)
    }

    if ((response.status === 429 || response.status >= 500) && attempt < retryDelaysMs.length) {
      await sleep(retryDelaysMs[attempt])
      continue
    }
    const detail = await response.text().catch(() => '')
    throw new Error(
      `npm bulk advisory endpoint returned ${response.status} ${response.statusText}: ${detail}`,
    )
  }

  throw new Error('npm bulk advisory request exhausted retries')
}

function loadProductionDependencyGraph() {
  const result = spawnSync(
    packageManager,
    ['list', '--prod', '--recursive', '--depth', 'Infinity', '--json'],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`pnpm production dependency graph failed:\n${result.stdout}${result.stderr}`)
  }
  try {
    return JSON.parse(result.stdout)
  } catch (error) {
    throw new Error(`pnpm production dependency graph is not valid JSON: ${error.message}`, {
      cause: error,
    })
  }
}

async function main() {
  const config = JSON.parse(readFileSync(releaseConfigPath, 'utf8'))
  const packages = collectProductionVersions(loadProductionDependencyGraph())
  const advisories = await fetchBulkAdvisories({ registry: config.registry, packages })
  const blocking = advisoriesAtOrAbove(advisories, 'low')

  if (blocking.length > 0) {
    const details = blocking
      .map(
        advisory =>
          `${advisory.severity} ${advisory.packageName} ${advisory.vulnerableVersions}: ` +
          `${advisory.title} (${advisory.url})`,
      )
      .join('\n- ')
    throw new Error(
      `Production dependency audit found ${blocking.length} advisories:\n- ${details}`,
    )
  }

  const versionCount = Object.values(packages).reduce(
    (total, versions) => total + versions.length,
    0,
  )
  process.stdout.write(
    `[security:audit:prod] Checked ${Object.keys(packages).length} packages / ` +
      `${versionCount} versions through the npm bulk advisory endpoint; no advisories found.\n`,
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`[security:audit:prod] ${error.stack ?? error.message ?? error}`)
    process.exitCode = 1
  })
}
