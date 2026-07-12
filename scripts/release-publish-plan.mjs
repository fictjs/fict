#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const defaultConfigPath = path.join(repoRoot, '.github/npm-publish-packages.json')
const workspaceRoots = ['packages', 'examples']

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}

export function normalizeRegistryDocument(value) {
  if (Array.isArray(value)) {
    if (value.length === 0) return null
    if (value.length === 1) return normalizeRegistryDocument(value[0])

    return value.find(entry => isRecord(entry) && entry.versions != null) ?? null
  }

  return isRecord(value) ? value : null
}

export function getPublishedVersions(value) {
  const document = normalizeRegistryDocument(value)
  const versions = document?.versions

  if (Array.isArray(versions)) {
    return uniqueSorted(versions.filter(version => typeof version === 'string'))
  }

  if (isRecord(versions)) {
    return uniqueSorted(Object.keys(versions))
  }

  return []
}

export function buildPublishPlan(packages, registryDocuments) {
  return packages.map(pkg => {
    const document = registryDocuments.get(pkg.name) ?? null
    const publishedVersions = getPublishedVersions(document)
    const packageExists = normalizeRegistryDocument(document) !== null

    return {
      name: pkg.name,
      path: pkg.path,
      version: pkg.version,
      status: publishedVersions.includes(pkg.version)
        ? 'already-published'
        : packageExists
          ? 'pending'
          : 'new-package',
    }
  })
}

export function validateReleaseConfiguration({ packages, allowedPackageNames, registry }) {
  const failures = []
  const allowed = new Set(allowedPackageNames)
  const packagesByName = new Map()

  if (typeof registry !== 'string' || !registry.startsWith('https://')) {
    failures.push('release registry must be an https URL')
  }

  if (allowed.size !== allowedPackageNames.length) {
    failures.push('npm publish allowlist contains duplicate package names')
  }

  if (allowedPackageNames.join('\n') !== uniqueSorted(allowedPackageNames).join('\n')) {
    failures.push('npm publish allowlist must remain sorted')
  }

  for (const pkg of packages) {
    if (packagesByName.has(pkg.name)) {
      failures.push(`duplicate workspace package name: ${pkg.name}`)
      continue
    }
    packagesByName.set(pkg.name, pkg)

    if (!allowed.has(pkg.name)) {
      if (pkg.private !== true) {
        failures.push(`${pkg.name} is outside the npm publish allowlist and must set private: true`)
      }
      if (pkg.publishConfig != null) {
        failures.push(`${pkg.name} is private and must not define publishConfig`)
      }
      continue
    }

    if (pkg.private === true) {
      failures.push(`${pkg.name} is allowlisted for npm but marked private`)
    }
    if (pkg.publishConfig?.access !== 'public') {
      failures.push(`${pkg.name} must set publishConfig.access to public`)
    }
    if (pkg.publishConfig?.provenance !== true) {
      failures.push(`${pkg.name} must enable publishConfig.provenance`)
    }
    if (pkg.repository?.url !== 'https://github.com/fictjs/fict.git') {
      failures.push(`${pkg.name} must use the canonical fictjs/fict repository URL`)
    }
    if (pkg.repository?.directory !== pkg.path) {
      failures.push(`${pkg.name} repository.directory must equal ${pkg.path}`)
    }
  }

  for (const packageName of allowed) {
    if (!packagesByName.has(packageName)) {
      failures.push(`npm publish allowlist references missing workspace package: ${packageName}`)
    }
  }

  return failures
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

function readWorkspacePackages(root) {
  const manifestPaths = ['package.json']

  for (const workspaceRoot of workspaceRoots) {
    const absoluteRoot = path.join(root, workspaceRoot)
    if (!existsSync(absoluteRoot)) continue

    for (const entry of readdirSync(absoluteRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const relativeManifest = path.join(workspaceRoot, entry.name, 'package.json')
      if (existsSync(path.join(root, relativeManifest))) manifestPaths.push(relativeManifest)
    }
  }

  return manifestPaths.map(manifestPath => {
    const manifest = readJson(path.join(root, manifestPath))
    return {
      ...manifest,
      path: path.dirname(manifestPath).split(path.sep).join('/'),
    }
  })
}

function registryPackageUrl(registry, packageName) {
  const encodedName = packageName.startsWith('@')
    ? packageName.replace('/', '%2f')
    : encodeURIComponent(packageName)
  return `${registry.replace(/\/$/, '')}/${encodedName}`
}

async function fetchRegistryDocument(registry, packageName) {
  const url = registryPackageUrl(registry, packageName)
  let lastError

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/vnd.npm.install-v1+json' },
      })
      if (response.status === 404) return null
      if (response.ok) return await response.json()
      if (response.status < 500 && response.status !== 429) {
        throw new Error(`registry returned ${response.status} ${response.statusText}`)
      }
      lastError = new Error(`registry returned ${response.status} ${response.statusText}`)
    } catch (error) {
      lastError = error
    }

    if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 250))
  }

  throw new Error(`failed to read ${packageName} from npm: ${lastError?.message ?? lastError}`)
}

function parseArguments(args) {
  const options = {
    allowNew: new Set(),
    configPath: defaultConfigPath,
    offline: false,
    outputPath: null,
    requireExistingPackages: false,
    tag: null,
  }

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--') continue
    if (argument === '--offline') {
      options.offline = true
      continue
    }
    if (argument === '--require-existing-packages') {
      options.requireExistingPackages = true
      continue
    }

    const value = args[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`)
    index += 1

    if (argument === '--allow-new') options.allowNew.add(value)
    else if (argument === '--config') options.configPath = path.resolve(repoRoot, value)
    else if (argument === '--output') options.outputPath = path.resolve(repoRoot, value)
    else if (argument === '--tag') options.tag = value
    else throw new Error(`unknown argument: ${argument}`)
  }

  return options
}

function printPlan(plan) {
  console.log('NPM release publish plan:')
  for (const entry of plan) {
    console.log(`- ${entry.name}@${entry.version}: ${entry.status}`)
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const config = readJson(options.configPath)
  const workspacePackages = readWorkspacePackages(repoRoot)
  const failures = validateReleaseConfiguration({
    packages: workspacePackages,
    allowedPackageNames: config.packages ?? [],
    registry: config.registry,
  })

  if (failures.length > 0) {
    throw new Error(`invalid npm release configuration:\n- ${failures.join('\n- ')}`)
  }

  if (options.offline) {
    console.log(`NPM release configuration passed for ${config.packages.length} public packages.`)
    return
  }

  const publicPackages = workspacePackages
    .filter(pkg => config.packages.includes(pkg.name))
    .sort((left, right) => left.name.localeCompare(right.name))
  const registryDocuments = new Map(
    await Promise.all(
      publicPackages.map(async pkg => [
        pkg.name,
        await fetchRegistryDocument(config.registry, pkg.name),
      ]),
    ),
  )
  const plan = buildPublishPlan(publicPackages, registryDocuments)
  const output = {
    generatedAt: new Date().toISOString(),
    registry: config.registry,
    tag: options.tag,
    packages: plan,
  }

  printPlan(plan)
  if (options.outputPath) writeFileSync(options.outputPath, `${JSON.stringify(output, null, 2)}\n`)

  const unexpectedNewPackages = plan.filter(
    entry => entry.status === 'new-package' && !options.allowNew.has(entry.name),
  )
  if (options.requireExistingPackages && unexpectedNewPackages.length > 0) {
    const names = unexpectedNewPackages.map(entry => entry.name).join(', ')
    throw new Error(
      `first npm publication requires an authenticated bootstrap before OIDC can be configured: ${names}`,
    )
  }

  const unusedAllowNew = [...options.allowNew].filter(
    packageName =>
      !plan.some(entry => entry.name === packageName && entry.status === 'new-package'),
  )
  if (unusedAllowNew.length > 0) {
    throw new Error(`--allow-new does not match a new package: ${unusedAllowNew.join(', ')}`)
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`NPM release plan failed: ${error.message}`)
    process.exitCode = 1
  })
}
