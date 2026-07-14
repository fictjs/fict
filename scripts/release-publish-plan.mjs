#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { NATIVE_COMPILER_TARGETS } from './native-compiler-packages.mjs'

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const defaultConfigPath = path.join(repoRoot, '.github/npm-publish-packages.json')
const workspaceRoots = ['packages', 'examples']
const registryRetryDelaysMs = [1_000, 2_000, 4_000, 8_000, 15_000]

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

export function buildAtomicPublishOrder(plan, packages = []) {
  const nativeNames = new Set(NATIVE_COMPILER_TARGETS.map(target => target.packageName))
  const native = plan
    .filter(entry => nativeNames.has(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))
  const manifests = new Map(packages.map(pkg => [pkg.name, pkg]))
  const remaining = new Map(
    plan.filter(entry => !nativeNames.has(entry.name)).map(entry => [entry.name, entry]),
  )
  const ordered = [...native]
  const published = new Set(native.map(entry => entry.name))

  while (remaining.size > 0) {
    const ready = [...remaining.values()]
      .filter(entry => {
        const manifest = manifests.get(entry.name)
        const dependencies = [
          ...Object.keys(manifest?.dependencies ?? {}),
          ...Object.keys(manifest?.optionalDependencies ?? {}),
        ]
        return dependencies.every(name => !remaining.has(name) || published.has(name))
      })
      .sort((left, right) => left.name.localeCompare(right.name))
    if (ready.length === 0) {
      throw new Error(
        `release dependency cycle prevents atomic publish ordering: ${[...remaining.keys()].join(', ')}`,
      )
    }
    for (const entry of ready) {
      ordered.push(entry)
      published.add(entry.name)
      remaining.delete(entry.name)
    }
  }
  return ordered
}

export function validateAtomicNativeReleaseConfiguration(packages, allowedPackageNames) {
  const failures = []
  const byName = new Map(packages.map(pkg => [pkg.name, pkg]))
  const compiler = byName.get('@fictjs/compiler')
  const nativePackages = NATIVE_COMPILER_TARGETS.map(target =>
    byName.get(target.packageName),
  ).filter(Boolean)
  if (!compiler && nativePackages.length === 0) return failures
  if (!compiler) {
    failures.push('native compiler packages require the @fictjs/compiler facade')
    return failures
  }

  for (const target of NATIVE_COMPILER_TARGETS) {
    const nativePackage = byName.get(target.packageName)
    if (!nativePackage) {
      failures.push(`native release matrix is missing ${target.packageName}`)
      continue
    }
    if (nativePackage.version !== compiler.version) {
      failures.push(
        `${target.packageName}@${nativePackage.version} must match @fictjs/compiler@${compiler.version}`,
      )
    }
    if (!allowedPackageNames.includes(target.packageName)) {
      failures.push(`native release matrix is not allowlisted: ${target.packageName}`)
    }
    if (compiler.optionalDependencies?.[target.packageName] !== 'workspace:*') {
      failures.push(`@fictjs/compiler must select ${target.packageName} through workspace:*`)
    }
  }
  return failures
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

  failures.push(...validateAtomicNativeReleaseConfiguration(packages, allowedPackageNames))

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

export async function fetchRegistryDocument(
  registry,
  packageName,
  {
    fetchImpl = fetch,
    now = Date.now,
    onRetry = message => console.warn(message),
    retryDelaysMs = registryRetryDelaysMs,
    sleep = delay => new Promise(resolve => setTimeout(resolve, delay)),
  } = {},
) {
  const baseUrl = registryPackageUrl(registry, packageName)
  let lastError

  for (let attempt = 1; attempt <= retryDelaysMs.length + 1; attempt += 1) {
    const isRetry = attempt > 1
    const url = isRetry ? `${baseUrl}?fict-release-check=${now()}-${attempt}` : baseUrl

    try {
      const response = await fetchImpl(url, {
        headers: {
          accept: 'application/vnd.npm.install-v1+json',
          ...(isRetry ? { 'cache-control': 'no-cache' } : {}),
        },
      })
      if (response.status === 404) {
        if (attempt > retryDelaysMs.length) return null
        lastError = new Error('registry returned 404 Not Found')
      } else if (response.ok) {
        return await response.json()
      } else if (response.status < 500 && response.status !== 429) {
        throw new Error(`registry returned ${response.status} ${response.statusText}`)
      } else {
        lastError = new Error(`registry returned ${response.status} ${response.statusText}`)
      }
    } catch (error) {
      lastError = error
    }

    if (attempt <= retryDelaysMs.length) {
      const delay = retryDelaysMs[attempt - 1]
      onRetry(
        `Registry lookup for ${packageName} failed (${lastError?.message ?? lastError}); ` +
          `retrying with cache bypass in ${delay}ms (${attempt + 1}/${retryDelaysMs.length + 1}).`,
      )
      await sleep(delay)
    }
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

function printPlan(plan, packages) {
  console.log('NPM release publish plan:')
  for (const entry of buildAtomicPublishOrder(plan, packages)) {
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

  const publicPackages = workspacePackages
    .filter(pkg => config.packages.includes(pkg.name))
    .sort((left, right) => left.name.localeCompare(right.name))
  buildAtomicPublishOrder(
    publicPackages.map(pkg => ({
      name: pkg.name,
      path: pkg.path,
      version: pkg.version,
      status: 'pending',
    })),
    publicPackages,
  )

  if (options.offline) {
    console.log(`NPM release configuration passed for ${config.packages.length} public packages.`)
    return
  }

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
    publishOrder: buildAtomicPublishOrder(plan, publicPackages).map(entry => entry.name),
  }

  printPlan(plan, publicPackages)
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
