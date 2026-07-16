import { readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { isCanonicalArrayPropIndex } from './metadata-indices'
import { MODULE_REACTIVE_METADATA_VERSION } from './types'
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
const MAX_METADATA_NAMESPACE_DEPTH = 32

interface FictPackageConfig {
  metadata?: string
  exports?: Record<string, string>
}

export interface PackageModuleMetadataResolutionOptions {
  /** Called for every package manifest and metadata asset consulted by the graph host. */
  onDependency?: (filename: string) => void
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
  let normalized = stripUrlLikeSuffix(fileName)
  if (normalized.startsWith('/@fs/')) {
    const fsPath = normalized.slice('/@fs/'.length)
    normalized = fsPath.startsWith('/') || isWindowsDrivePath(fsPath) ? fsPath : `/${fsPath}`
  }
  if (normalized.startsWith('file://')) {
    try {
      normalized = fileURLToPath(normalized)
    } catch {
      return null
    }
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
      !normalizedParts[0] ||
      !normalizedParts[1] ||
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
  if (!normalizedParts[0]) return null
  const normalizedRest = normalizedParts.slice(1).join('/')
  const rawRest = rawParts.slice(1).join('/')
  return {
    packageName: normalizedParts[0],
    subpath: normalizedRest ? `./${normalizedRest}` : '.',
    rawSubpath: rawRest ? `./${rawRest}` : '.',
  }
}

function findPackageJsonPath(packageName: string, importer: string | undefined): string | null {
  const normalizedImporter = normalizeConcreteFileName(importer)
  if (!normalizedImporter) return null

  let current = path.dirname(normalizedImporter)
  while (true) {
    const candidate = path.join(current, 'node_modules', packageName, 'package.json')
    if (pathIsFile(candidate)) return candidate

    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

function readPackageConfig(packageJsonPath: string): FictPackageConfig | null {
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { fict?: unknown }
    if (!isPlainObject(pkg.fict)) return null

    const config: FictPackageConfig = {}
    if (typeof pkg.fict.metadata === 'string') config.metadata = pkg.fict.metadata
    if (isPlainObject(pkg.fict.exports)) {
      const exportsConfig: Record<string, string> = {}
      for (const [key, value] of Object.entries(pkg.fict.exports)) {
        if (typeof value === 'string') exportsConfig[key] = value
      }
      if (Object.keys(exportsConfig).length > 0) config.exports = exportsConfig
    }
    return config.metadata || config.exports ? config : null
  } catch {
    return null
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
): ModuleReactiveMetadata | undefined {
  if (!pathIsFile(metadataPath)) return undefined
  try {
    const packageRoot = realpathSync(packageDir)
    const realMetadataPath = realpathSync(metadataPath)
    if (!isPathInside(packageRoot, realMetadataPath)) return undefined
    return parseModuleReactiveMetadata(readFileSync(realMetadataPath, 'utf8')) ?? undefined
  } catch {
    return undefined
  }
}

/** Resolve package-published Rust metadata. Source-adjacent Babel sidecars are not supported. */
export function resolvePackageModuleMetadata(
  source: string,
  importer: string | undefined,
  options: PackageModuleMetadataResolutionOptions = {},
): ModuleReactiveMetadata | undefined {
  const parsedSource = splitPackageSource(source)
  if (!parsedSource) return undefined

  const packageJsonPath = findPackageJsonPath(parsedSource.packageName, importer)
  if (!packageJsonPath) return undefined
  options.onDependency?.(packageJsonPath)

  const packageConfig = readPackageConfig(packageJsonPath)
  if (!packageConfig) return undefined

  const packageDir = path.dirname(packageJsonPath)
  const declaredPath =
    packageConfig.exports?.[parsedSource.rawSubpath] ??
    packageConfig.exports?.[parsedSource.subpath] ??
    (parsedSource.subpath === '.' ? packageConfig.metadata : undefined)
  if (!declaredPath) return undefined

  const metadataPath = normalizePackageMetadataPath(packageDir, declaredPath)
  if (!metadataPath) return undefined
  options.onDependency?.(metadataPath)
  return readPackageMetadataFile(metadataPath, packageDir)
}
