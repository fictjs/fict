import { readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { isCanonicalArrayPropIndex } from './metadata-indices'
import { MAX_METADATA_NAMESPACE_DEPTH, MODULE_REACTIVE_METADATA_VERSION } from './types'
import type { ModuleReactiveMetadata } from './types'

const UNKNOWN_FILENAME_TOKENS = new Set(['<unknown>', 'unknown', 'stdin', '[stdin]'])
const VIRTUAL_FILENAME_PREFIXES = [
  'virtual:',
  'vite:',
  'rollup:',
  'webpack:',
  'rspack:',
  'esbuild:',
  'astro:',
  'data:',
  'http://',
  'https://',
]
const MODULE_METADATA_KEYS = new Set(['version', 'exports', 'hooks', 'namespaces'])
const HOOK_RETURN_KEYS = new Set(['objectProps', 'arrayProps', 'directAccessor'])

interface FictPackageConfig {
  metadata?: string
  exports?: Record<string, string>
}

type PackageConfigReadResult =
  | { kind: 'configured'; config: FictPackageConfig }
  | { kind: 'invalid' }
  | { kind: 'plain' }

export type PackageModuleMetadataResolution =
  | { kind: 'resolved'; metadata: ModuleReactiveMetadata }
  | { kind: 'plain' }
  | { kind: 'missing' }
  | { kind: 'invalid' }

export interface PackageModuleMetadataResolveRequest {
  source: string
  importer: string
  packageName: string
  publicSubpath: '.' | `./${string}`
}

export interface PackageModuleMetadataBoundary {
  packageJsonPath: string
  publicSubpath?: '.' | `./${string}`
}

export type PackageModuleMetadataHostResolution =
  | PackageModuleMetadataBoundary
  | PackageModuleMetadataResolution
  | null
  | undefined

export interface PackageModuleMetadataResolutionOptions {
  /** Called for every package manifest and metadata asset consulted by the graph host. */
  onDependency?: (filename: string) => void
  /**
   * Host-owned package resolution for PnP, virtual modules, aliases, and custom module roots.
   * Return `undefined` to use the physical node_modules fallback, `null` for an authoritative
   * miss, a package boundary for graph-host metadata loading, or a final discriminated state.
   */
  resolvePackage?: (
    request: PackageModuleMetadataResolveRequest,
  ) => PackageModuleMetadataHostResolution
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every(key => allowed.has(key))
}

function isReactiveExportKind(value: unknown): value is ModuleReactiveMetadata['exports'][string] {
  return value === 'signal' || value === 'memo' || value === 'store'
}

function isHookReturnInfo(value: unknown): boolean {
  if (!isPlainObject(value) || !hasOnlyKeys(value, HOOK_RETURN_KEYS)) return false

  if ('directAccessor' in value && !isReactiveExportKind(value.directAccessor)) return false

  if ('objectProps' in value) {
    if (!isPlainObject(value.objectProps)) return false
    if (!Object.values(value.objectProps).every(isReactiveExportKind)) return false
  }

  if ('arrayProps' in value) {
    if (!isPlainObject(value.arrayProps)) return false
    if (!Object.keys(value.arrayProps).every(isCanonicalArrayPropIndex)) return false
    if (!Object.values(value.arrayProps).every(isReactiveExportKind)) return false
  }

  return true
}

function isModuleReactiveMetadata(value: unknown, depth = 0): value is ModuleReactiveMetadata {
  if (
    depth > MAX_METADATA_NAMESPACE_DEPTH ||
    !isPlainObject(value) ||
    !hasOnlyKeys(value, MODULE_METADATA_KEYS) ||
    value.version !== MODULE_REACTIVE_METADATA_VERSION ||
    !isPlainObject(value.exports) ||
    !Object.values(value.exports).every(isReactiveExportKind)
  ) {
    return false
  }

  if ('hooks' in value) {
    if (!isPlainObject(value.hooks)) return false
    if (!Object.values(value.hooks).every(isHookReturnInfo)) return false
  }

  if ('namespaces' in value) {
    if (!isPlainObject(value.namespaces)) return false
    if (
      !Object.values(value.namespaces).every(namespace =>
        isModuleReactiveMetadata(namespace, depth + 1),
      )
    ) {
      return false
    }
  }

  return true
}

/** Parse the versioned Rust metadata protocol. Unversioned and unknown-schema payloads fail closed. */
export function parseModuleReactiveMetadata(raw: string): ModuleReactiveMetadata | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    return isModuleReactiveMetadata(parsed) ? parsed : null
  } catch {
    return null
  }
}

const isWindowsDrivePath = (fileName: string): boolean =>
  /^[a-zA-Z]:[\\/]/.test(fileName) || fileName.startsWith('\\\\')

function isVirtualFileName(fileName: string): boolean {
  const trimmed = fileName.trim()
  if (!trimmed) return true
  const lower = trimmed.toLowerCase()
  if (UNKNOWN_FILENAME_TOKENS.has(lower) || trimmed.startsWith('\0')) return true
  if (VIRTUAL_FILENAME_PREFIXES.some(prefix => lower.startsWith(prefix))) return true
  return trimmed.includes('://') && !lower.startsWith('file://') && !isWindowsDrivePath(trimmed)
}

function stripUrlLikeSuffix(value: string): string {
  const queryStart = value.indexOf('?')
  const fragmentStart = value.indexOf('#')
  const suffixStart =
    queryStart === -1
      ? fragmentStart
      : fragmentStart === -1
        ? queryStart
        : Math.min(queryStart, fragmentStart)
  return suffixStart === -1 ? value : value.slice(0, suffixStart)
}

function normalizeConcreteFileName(fileName: string | undefined): string | null {
  if (!fileName || isVirtualFileName(fileName)) return null
  let normalized = fileName
  if (normalized.startsWith('/@fs/')) {
    const rawFsPath = normalized.slice('/@fs/'.length)
    const fsPath =
      rawFsPath.startsWith('/') || isWindowsDrivePath(rawFsPath) ? rawFsPath : `/${rawFsPath}`
    normalized = pathIsFile(fsPath) ? fsPath : stripUrlLikeSuffix(fsPath)
  }
  if (normalized.startsWith('file://')) {
    try {
      normalized = fileURLToPath(normalized)
    } catch {
      return null
    }
  } else if (!pathIsFile(path.resolve(normalized))) {
    normalized = stripUrlLikeSuffix(normalized)
  }
  return path.resolve(normalized)
}

function pathIsFile(pathName: string): boolean {
  try {
    return statSync(pathName).isFile()
  } catch {
    return false
  }
}

function isBarePackageSource(source: string): boolean {
  return !path.isAbsolute(source) && !source.startsWith('.') && !source.startsWith('/@fs/')
}

function isCanonicalPackageNameSegment(segment: string): boolean {
  return (
    !!segment &&
    segment !== '.' &&
    segment !== '..' &&
    !segment.includes('\\') &&
    !segment.includes('\0')
  )
}

function isCanonicalPublicSubpath(subpath: string): subpath is '.' | `./${string}` {
  if (subpath === '.') return true
  if (!subpath.startsWith('./') || subpath.includes('\\') || subpath.includes('\0')) return false
  const segments = subpath.slice(2).split('/')
  return segments.every(segment => !!segment && segment !== '.' && segment !== '..')
}

function splitPackageSource(
  source: string,
): { packageName: string; subpath: string; rawSubpath: string } | null {
  const normalizedSource = stripUrlLikeSuffix(source)
  if (!isBarePackageSource(normalizedSource)) return null
  const normalizedParts = normalizedSource.split('/')
  const rawParts = source.split('/')
  if (normalizedSource.startsWith('@')) {
    if (
      normalizedParts.length < 2 ||
      !normalizedParts[0]?.startsWith('@') ||
      !isCanonicalPackageNameSegment(normalizedParts[0].slice(1)) ||
      !isCanonicalPackageNameSegment(normalizedParts[1] ?? '') ||
      rawParts.length < 2
    ) {
      return null
    }
    const packageName = `${normalizedParts[0]}/${normalizedParts[1]}`
    const normalizedRest = normalizedParts.slice(2).join('/')
    const rawRest = rawParts.slice(2).join('/')
    return {
      packageName,
      subpath: normalizedRest ? `./${normalizedRest}` : '.',
      rawSubpath: rawRest ? `./${rawRest}` : '.',
    }
  }
  if (!isCanonicalPackageNameSegment(normalizedParts[0] ?? '')) return null
  const normalizedRest = normalizedParts.slice(1).join('/')
  const rawRest = rawParts.slice(1).join('/')
  return {
    packageName: normalizedParts[0]!,
    subpath: normalizedRest ? `./${normalizedRest}` : '.',
    rawSubpath: rawRest ? `./${rawRest}` : '.',
  }
}

function findPackageJsonPath(
  packageName: string,
  importer: string | undefined,
  onDependency: ((filename: string) => void) | undefined,
): string | null {
  const normalizedImporter = normalizeConcreteFileName(importer)
  if (!normalizedImporter) return null

  let current = path.dirname(normalizedImporter)
  while (true) {
    const candidate = path.join(current, 'node_modules', packageName, 'package.json')
    onDependency?.(candidate)
    if (pathIsFile(candidate)) return candidate

    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

function readPackageConfig(packageJsonPath: string): PackageConfigReadResult {
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as unknown
    if (!isPlainObject(pkg)) return { kind: 'invalid' }
    if (!Object.prototype.hasOwnProperty.call(pkg, 'fict')) return { kind: 'plain' }
    if (!isPlainObject(pkg.fict)) return { kind: 'invalid' }

    const config: FictPackageConfig = {}
    let hasDeclaration = false
    if (Object.prototype.hasOwnProperty.call(pkg.fict, 'metadata')) {
      hasDeclaration = true
      if (typeof pkg.fict.metadata !== 'string') return { kind: 'invalid' }
      config.metadata = pkg.fict.metadata
    }
    if (Object.prototype.hasOwnProperty.call(pkg.fict, 'exports')) {
      if (!isPlainObject(pkg.fict.exports)) return { kind: 'invalid' }
      const exportsConfig: Record<string, string> = {}
      for (const [key, value] of Object.entries(pkg.fict.exports)) {
        hasDeclaration = true
        if (typeof value !== 'string') return { kind: 'invalid' }
        exportsConfig[key] = value
      }
      if (Object.keys(exportsConfig).length > 0) config.exports = exportsConfig
    }
    return hasDeclaration ? { kind: 'configured', config } : { kind: 'invalid' }
  } catch {
    return { kind: 'invalid' }
  }
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))
}

function normalizePackageMetadataPath(packageDir: string, metadataPath: string): string | null {
  if (
    !metadataPath ||
    metadataPath.includes('\0') ||
    path.isAbsolute(metadataPath) ||
    metadataPath.startsWith('file://') ||
    metadataPath.startsWith('/@fs/')
  ) {
    return null
  }

  const normalizedPackageDir = path.resolve(packageDir)
  const resolved = path.resolve(normalizedPackageDir, metadataPath)
  return isPathInside(normalizedPackageDir, resolved) ? resolved : null
}

function readPackageMetadataFile(
  metadataPath: string,
  packageDir: string,
): PackageModuleMetadataResolution {
  if (!pathIsFile(metadataPath)) return { kind: 'missing' }
  try {
    const packageRoot = realpathSync(packageDir)
    const realMetadataPath = realpathSync(metadataPath)
    if (!isPathInside(packageRoot, realMetadataPath)) return { kind: 'invalid' }
    const metadata = parseModuleReactiveMetadata(readFileSync(realMetadataPath, 'utf8'))
    return metadata ? { kind: 'resolved', metadata } : { kind: 'invalid' }
  } catch {
    return { kind: 'invalid' }
  }
}

/** Resolve package-published Rust metadata without collapsing plain and failed declarations. */
export function resolvePackageModuleMetadataState(
  source: string,
  importer: string | undefined,
  options: PackageModuleMetadataResolutionOptions = {},
): PackageModuleMetadataResolution {
  const parsedSource = splitPackageSource(source)
  const normalizedImporter = normalizeConcreteFileName(importer)
  if (!parsedSource || !normalizedImporter) return { kind: 'invalid' }

  let hostResolution: PackageModuleMetadataHostResolution
  try {
    hostResolution = options.resolvePackage?.({
      source,
      importer: normalizedImporter,
      packageName: parsedSource.packageName,
      publicSubpath: parsedSource.subpath as '.' | `./${string}`,
    })
  } catch {
    return { kind: 'invalid' }
  }

  if (hostResolution === null) return { kind: 'missing' }
  if (hostResolution && 'kind' in hostResolution) return hostResolution

  let publicSubpath = parsedSource.subpath
  let rawPublicSubpath = parsedSource.rawSubpath
  let packageJsonPath: string | null
  if (hostResolution) {
    if (
      !hostResolution.packageJsonPath ||
      hostResolution.packageJsonPath.includes('\0') ||
      (hostResolution.publicSubpath !== undefined &&
        !isCanonicalPublicSubpath(hostResolution.publicSubpath))
    ) {
      return { kind: 'invalid' }
    }
    packageJsonPath = path.resolve(hostResolution.packageJsonPath)
    publicSubpath = hostResolution.publicSubpath ?? publicSubpath
    rawPublicSubpath = publicSubpath
    options.onDependency?.(packageJsonPath)
    if (!pathIsFile(packageJsonPath)) return { kind: 'missing' }
  } else {
    packageJsonPath = findPackageJsonPath(parsedSource.packageName, importer, options.onDependency)
    if (!packageJsonPath) return { kind: 'missing' }
  }

  const packageConfigResult = readPackageConfig(packageJsonPath)
  if (packageConfigResult.kind !== 'configured') return packageConfigResult
  const packageConfig = packageConfigResult.config

  const packageDir = path.dirname(packageJsonPath)
  const declaredPath =
    packageConfig.exports?.[rawPublicSubpath] ??
    packageConfig.exports?.[publicSubpath] ??
    (publicSubpath === '.' ? packageConfig.metadata : undefined)
  if (declaredPath === undefined) return { kind: 'plain' }

  const metadataPath = normalizePackageMetadataPath(packageDir, declaredPath)
  if (!metadataPath) return { kind: 'invalid' }
  options.onDependency?.(metadataPath)
  return readPackageMetadataFile(metadataPath, packageDir)
}

/** Resolve package-published Rust metadata. Source-adjacent Babel sidecars are not supported. */
export function resolvePackageModuleMetadata(
  source: string,
  importer: string | undefined,
  options: PackageModuleMetadataResolutionOptions = {},
): ModuleReactiveMetadata | undefined {
  const resolution = resolvePackageModuleMetadataState(source, importer, options)
  return resolution.kind === 'resolved' ? resolution.metadata : undefined
}
