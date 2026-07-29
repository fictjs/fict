import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'

import type { ModuleReactiveMetadata } from '@fictjs/compiler'
import { parseModuleReactiveMetadata } from '@fictjs/compiler/graph-host'

export type PackagePublicSubpath = '.' | `./${string}`

interface FictPackageConfig {
  hasValidDeclaration: boolean
  metadata?: string | null
  exports?: Record<string, string | null>
}

export interface FictWebpackPackageResolution {
  packageJsonPath: string
  publicSubpath: PackagePublicSubpath | null
  resourcePaths: string[]
  metadataKeyFingerprint: string
  runtimeMappingFingerprint: string
  externalMappingFingerprint?: string
}

export interface FictWebpackUnresolvedPackageResolution {
  kind: 'unresolved'
  externalMappingFingerprint: string
}

export type FictWebpackPackageResolutionState =
  | FictWebpackPackageResolution
  | FictWebpackUnresolvedPackageResolution
  | 'opaque'
  | 'unresolved'

export function isUnresolvedPackageResolution(
  resolution: FictWebpackPackageResolutionState,
): resolution is FictWebpackUnresolvedPackageResolution {
  return typeof resolution === 'object' && 'kind' in resolution && resolution.kind === 'unresolved'
}

export type PackageMetadataBoundaryResult =
  | { kind: 'plain' }
  | { kind: 'resolved'; metadata: ModuleReactiveMetadata }
  | { kind: 'stale-boundary'; message: string }
  | { kind: 'unresolved' }

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function resolveContainedFile(packageRoot: string, filename: string): string | null | undefined {
  try {
    const realPath = realpathSync(filename)
    return isPathInside(packageRoot, realPath) && statSync(realPath).isFile() ? realPath : null
  } catch (error) {
    return isMissingPathError(error) ? undefined : null
  }
}

function isCanonicalPackagePathSegment(segment: string): boolean {
  const decodedSegment = segment.replace(/%([0-9a-f]{2})/gi, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  )
  return (
    segment !== '' &&
    decodedSegment !== '.' &&
    decodedSegment !== '..' &&
    decodedSegment.toLowerCase() !== 'node_modules'
  )
}

export function isCanonicalPublicSubpath(value: string): value is PackagePublicSubpath {
  if (value === '.') return true
  if (!value.startsWith('./') || value.length === 2 || value.endsWith('/')) return false
  if (
    value.includes('\0') ||
    value.includes('\\') ||
    value.includes('?') ||
    value.includes('#') ||
    value.includes('*')
  ) {
    return false
  }
  return value.slice(2).split('/').every(isCanonicalPackagePathSegment)
}

const PACKAGE_NAME_SEGMENT_RE = /^[A-Za-z0-9._~-]+$/

function isCanonicalPackageNameSegment(value: string): boolean {
  return (
    value !== '.' &&
    value !== '..' &&
    value !== 'node_modules' &&
    PACKAGE_NAME_SEGMENT_RE.test(value)
  )
}

export function isCanonicalPackageName(value: string): boolean {
  if (value.startsWith('@')) {
    const parts = value.split('/')
    return (
      parts.length === 2 &&
      isCanonicalPackageNameSegment(parts[0]!.slice(1)) &&
      isCanonicalPackageNameSegment(parts[1]!)
    )
  }
  return !value.includes('/') && isCanonicalPackageNameSegment(value)
}

function normalizeMetadataDeclaration(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    !value ||
    path.isAbsolute(value) ||
    value.startsWith('file://') ||
    value.startsWith('/@fs/')
  ) {
    return null
  }
  const packageTarget = value.startsWith('./') ? value : `./${value}`
  return isCanonicalPackageRelativeTarget(packageTarget, false) ? value : null
}

function readFictPackageConfig(packageData: unknown): FictPackageConfig | undefined {
  if (!packageData || typeof packageData !== 'object' || Array.isArray(packageData))
    return undefined
  const data = packageData as Record<string, unknown>
  const config: FictPackageConfig = { hasValidDeclaration: false }
  let hasConfig = false
  if (data.fict && typeof data.fict === 'object' && !Array.isArray(data.fict)) {
    const fict = data.fict as { metadata?: unknown; exports?: unknown }
    if (Object.prototype.hasOwnProperty.call(fict, 'metadata')) {
      hasConfig = true
      if (typeof fict.metadata !== 'string') return { hasValidDeclaration: false }
      config.metadata = normalizeMetadataDeclaration(fict.metadata)
      if (config.metadata) config.hasValidDeclaration = true
    }
    if (Object.prototype.hasOwnProperty.call(fict, 'exports')) {
      if (!fict.exports || typeof fict.exports !== 'object' || Array.isArray(fict.exports)) {
        return { hasValidDeclaration: false }
      }
      hasConfig = true
      const exportsConfig: Record<string, string | null> = {}
      for (const [subpath, metadataPath] of Object.entries(fict.exports)) {
        if (!isCanonicalPublicSubpath(subpath) || typeof metadataPath !== 'string') {
          return { hasValidDeclaration: false }
        }
        exportsConfig[subpath] = normalizeMetadataDeclaration(metadataPath)
        if (exportsConfig[subpath]) config.hasValidDeclaration = true
      }
      if (Object.keys(exportsConfig).length > 0) config.exports = exportsConfig
    }
  }
  return hasConfig ? config : undefined
}

function stableStringify(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  return `{${Object.keys(value)
    .sort()
    .map(
      key => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
    )
    .join(',')}}`
}

export function getPackageRuntimeMappingFingerprint(packageData: unknown): string {
  if (!packageData || typeof packageData !== 'object' || Array.isArray(packageData)) {
    return createHash('sha256').update('null').digest('hex')
  }
  const data = packageData as Record<string, unknown>
  const mapping: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    if (key !== 'fict') mapping[key] = value
  }
  return createHash('sha256').update(stableStringify(mapping)).digest('hex')
}

export function getPackageMetadataSubpaths(packageData: unknown): PackagePublicSubpath[] {
  const config = readFictPackageConfig(packageData)
  if (!config?.hasValidDeclaration) return []
  const subpaths = new Set<PackagePublicSubpath>()
  if (config.metadata !== undefined) subpaths.add('.')
  for (const subpath of Object.keys(config.exports ?? {})) {
    if (isCanonicalPublicSubpath(subpath)) subpaths.add(subpath)
  }
  return [...subpaths].sort()
}

export function getPackageMetadataKeyFingerprint(packageData: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(getPackageMetadataSubpaths(packageData)))
    .digest('hex')
}

function isCanonicalPublicPattern(value: string): boolean {
  if (
    !value.startsWith('./') ||
    !value.includes('*') ||
    value.indexOf('*') !== value.lastIndexOf('*') ||
    value.endsWith('/') ||
    value.includes('\0') ||
    value.includes('\\') ||
    value.includes('?') ||
    value.includes('#')
  ) {
    return false
  }
  return value.slice(2).split('/').every(isCanonicalPackagePathSegment)
}

function collectExportTargets(value: unknown, targets: string[]): void {
  if (typeof value === 'string') {
    targets.push(value)
    return
  }
  if (!value || typeof value !== 'object') return
  for (const nested of Array.isArray(value) ? value : Object.values(value)) {
    collectExportTargets(nested, targets)
  }
}

function isValidConditionalExportMapping(
  value: Record<string, unknown>,
  allowWildcard: boolean,
): boolean {
  const entries = Object.entries(value)
  const defaultIndex = entries.findIndex(([condition]) => condition === 'default')
  return (
    (defaultIndex === -1 || defaultIndex === entries.length - 1) &&
    entries.every(([, mapping]) => isValidRuntimeExportMapping(mapping, allowWildcard, true))
  )
}

function isValidRuntimeExportMapping(
  value: unknown,
  allowWildcard: boolean,
  allowArray: boolean,
): boolean {
  if (value === null) return true
  if (typeof value === 'string') {
    return isCanonicalPackageRelativeTarget(value, allowWildcard)
  }
  if (Array.isArray(value)) {
    if (!allowArray) return false
    return value.every(entry => {
      if (typeof entry === 'string') {
        return isValidRuntimeExportMapping(entry, allowWildcard, false)
      }
      return (
        !!entry &&
        typeof entry === 'object' &&
        !Array.isArray(entry) &&
        isValidConditionalExportMapping(entry as Record<string, unknown>, allowWildcard)
      )
    })
  }
  return (
    !!value &&
    typeof value === 'object' &&
    isValidConditionalExportMapping(value as Record<string, unknown>, allowWildcard)
  )
}

function getRuntimeExportEntries(value: unknown): [string, unknown][] {
  if (typeof value === 'string' || Array.isArray(value)) {
    return isValidRuntimeExportMapping(value, false, true) ? [['.', value]] : []
  }
  if (!value || typeof value !== 'object') return []
  const entries = Object.entries(value)
  const firstKey = entries[0]?.[0]
  if (firstKey?.startsWith('.')) {
    return entries.every(
      ([key, mapping]) =>
        (isCanonicalPublicSubpath(key) || isCanonicalPublicPattern(key)) &&
        isValidRuntimeExportMapping(mapping, key.includes('*'), true),
    )
      ? entries
      : []
  }
  return !entries.some(([key]) => key.startsWith('.') || key.startsWith('/')) &&
    isValidConditionalExportMapping(value as Record<string, unknown>, false)
    ? [['.', value]]
    : []
}

function isCanonicalPackageRelativeTarget(value: string, allowWildcard: boolean): boolean {
  if (
    !value.startsWith('./') ||
    value.length === 2 ||
    value.includes('\0') ||
    value.includes('\\') ||
    value.includes('?') ||
    value.includes('#') ||
    (!allowWildcard && value.includes('*'))
  ) {
    return false
  }
  return value.slice(2).split('/').every(isCanonicalPackagePathSegment)
}

function resolvePublicPattern(
  publicPattern: string,
  targetPattern: string,
  actualTarget: string,
): PackagePublicSubpath | undefined {
  if (
    !isCanonicalPublicPattern(publicPattern) ||
    !isCanonicalPackageRelativeTarget(targetPattern, true) ||
    !targetPattern.includes('*')
  ) {
    return undefined
  }
  const firstWildcard = targetPattern.indexOf('*')
  const lastWildcard = targetPattern.lastIndexOf('*')
  const prefix = targetPattern.slice(0, firstWildcard)
  const suffix = targetPattern.slice(lastWildcard + 1)
  if (!actualTarget.startsWith(prefix) || !actualTarget.endsWith(suffix)) return undefined
  const wildcard = actualTarget.slice(prefix.length, actualTarget.length - suffix.length)
  if (!wildcard || targetPattern.split('*').join(wildcard) !== actualTarget) return undefined
  const subpath = publicPattern.split('*').join(wildcard)
  return isCanonicalPublicSubpath(subpath) ? subpath : undefined
}

function resolveTargetPattern(
  publicPattern: string,
  targetPattern: string,
  publicSubpath: PackagePublicSubpath,
): string | undefined {
  if (
    !isCanonicalPublicPattern(publicPattern) ||
    !isCanonicalPackageRelativeTarget(targetPattern, true)
  ) {
    return undefined
  }
  const firstWildcard = publicPattern.indexOf('*')
  const lastWildcard = publicPattern.lastIndexOf('*')
  const prefix = publicPattern.slice(0, firstWildcard)
  const suffix = publicPattern.slice(lastWildcard + 1)
  if (!publicSubpath.startsWith(prefix) || !publicSubpath.endsWith(suffix)) return undefined
  const wildcard = publicSubpath.slice(prefix.length, publicSubpath.length - suffix.length)
  if (!wildcard || publicPattern.split('*').join(wildcard) !== publicSubpath) return undefined
  return targetPattern.split('*').join(wildcard)
}

export function getPackageRuntimeTargets(
  packageData: unknown,
  publicSubpath: PackagePublicSubpath,
): string[] {
  if (!packageData || typeof packageData !== 'object' || Array.isArray(packageData)) return []
  const runtimeExports = (packageData as Record<string, unknown>).exports
  const targets = new Set<string>()
  for (const [publicEntry, target] of getRuntimeExportEntries(runtimeExports)) {
    const entryTargets: string[] = []
    collectExportTargets(target, entryTargets)
    for (const entryTarget of entryTargets) {
      const resolvedTarget =
        publicEntry === publicSubpath
          ? entryTarget
          : resolveTargetPattern(publicEntry, entryTarget, publicSubpath)
      if (resolvedTarget && isCanonicalPackageRelativeTarget(resolvedTarget, false)) {
        targets.add(resolvedTarget)
      }
    }
  }
  return [...targets].sort()
}

export function getPackageNonInvertibleRuntimeTargets(packageData: unknown): string[] {
  if (!packageData || typeof packageData !== 'object' || Array.isArray(packageData)) return []
  const runtimeExports = (packageData as Record<string, unknown>).exports
  const targets = new Set<string>()
  for (const [publicEntry, target] of getRuntimeExportEntries(runtimeExports)) {
    if (!isCanonicalPublicPattern(publicEntry)) continue
    const entryTargets: string[] = []
    collectExportTargets(target, entryTargets)
    for (const entryTarget of entryTargets) {
      if (!entryTarget.includes('*') && isCanonicalPackageRelativeTarget(entryTarget, false)) {
        targets.add(entryTarget)
      }
    }
  }
  return [...targets].sort()
}

export function getPackageRuntimeSubpaths(
  packageData: unknown,
  packageJsonPath?: string,
  resourcePath?: string,
): PackagePublicSubpath[] {
  const subpaths = new Set<PackagePublicSubpath>(['.'])
  if (!packageData || typeof packageData !== 'object' || Array.isArray(packageData)) {
    return [...subpaths]
  }
  const runtimeExports = (packageData as Record<string, unknown>).exports
  if (runtimeExports !== undefined && runtimeExports !== null) {
    const actualTarget =
      packageJsonPath && resourcePath
        ? `./${path
            .relative(path.dirname(path.resolve(packageJsonPath)), path.resolve(resourcePath))
            .split(path.sep)
            .join('/')}`
        : undefined
    for (const [subpath, target] of getRuntimeExportEntries(runtimeExports)) {
      if (isCanonicalPublicSubpath(subpath)) subpaths.add(subpath)
      if (!actualTarget) continue
      const targets: string[] = []
      collectExportTargets(target, targets)
      for (const targetPattern of targets) {
        const resolved = resolvePublicPattern(subpath, targetPattern, actualTarget)
        if (resolved) subpaths.add(resolved)
      }
    }
  }
  return [...subpaths].sort()
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))
}

function resolveThroughExistingAncestor(filename: string): string | undefined {
  let current = filename
  const missingSegments: string[] = []
  while (true) {
    try {
      return path.join(realpathSync(current), ...missingSegments)
    } catch (error) {
      if (!isMissingPathError(error)) return undefined
      const parent = path.dirname(current)
      if (parent === current) return undefined
      missingSegments.unshift(path.basename(current))
      current = parent
    }
  }
}

export function resolvePackageRuntimeTargetPath(
  packageJsonPath: string,
  target: string,
): string | undefined {
  if (!isCanonicalPackageRelativeTarget(target, false)) return undefined
  const packageRoot = path.dirname(path.resolve(packageJsonPath))
  const resolvedTarget = path.resolve(packageRoot, target)
  if (resolvedTarget === packageRoot || !isPathInside(packageRoot, resolvedTarget)) return undefined
  try {
    const realPackageRoot = realpathSync(packageRoot)
    const realTarget = resolveThroughExistingAncestor(resolvedTarget)
    return realTarget && isPathInside(realPackageRoot, realTarget) ? resolvedTarget : undefined
  } catch {
    return undefined
  }
}

export function isPackageResourcePathContained(
  packageJsonPath: string,
  resourcePath: string,
): boolean {
  try {
    const realPackageRoot = realpathSync(path.dirname(path.resolve(packageJsonPath)))
    const realResourcePath = realpathSync(path.resolve(resourcePath))
    return isPathInside(realPackageRoot, realResourcePath) && statSync(realResourcePath).isFile()
  } catch {
    return false
  }
}

export function packageResourcePathsMatch(
  packageJsonPath: string,
  left: string,
  right: string,
): boolean {
  if (
    !isPackageResourcePathContained(packageJsonPath, left) ||
    !isPackageResourcePathContained(packageJsonPath, right)
  ) {
    return false
  }
  try {
    return realpathSync(left) === realpathSync(right)
  } catch {
    return false
  }
}

function normalizeMetadataPath(packageDir: string, metadataPath: string): string | undefined {
  if (
    !metadataPath ||
    metadataPath.includes('\0') ||
    path.isAbsolute(metadataPath) ||
    metadataPath.startsWith('file://') ||
    metadataPath.startsWith('/@fs/')
  ) {
    return undefined
  }
  const resolved = path.resolve(packageDir, metadataPath)
  return isPathInside(packageDir, resolved) ? resolved : undefined
}

export function readPackageMetadataAtBoundary(
  resolution: FictWebpackPackageResolution,
  onDependency: (filename: string) => void,
): PackageMetadataBoundaryResult {
  const packageJsonPath = path.resolve(resolution.packageJsonPath)
  const packageDir = path.dirname(packageJsonPath)
  let packageRoot: string
  try {
    packageRoot = realpathSync(packageDir)
  } catch (error) {
    if (isMissingPathError(error)) onDependency(packageJsonPath)
    return { kind: 'unresolved' }
  }

  const realManifestPath = resolveContainedFile(packageRoot, packageJsonPath)
  if (realManifestPath === undefined) {
    onDependency(packageJsonPath)
    return { kind: 'unresolved' }
  }
  if (realManifestPath === null) return { kind: 'unresolved' }
  onDependency(packageJsonPath)

  try {
    const packageData = JSON.parse(readFileSync(realManifestPath, 'utf8')) as unknown
    if (
      getPackageRuntimeMappingFingerprint(packageData) !== resolution.runtimeMappingFingerprint ||
      getPackageMetadataKeyFingerprint(packageData) !== resolution.metadataKeyFingerprint
    ) {
      return {
        kind: 'stale-boundary',
        message:
          `[fict] Webpack package boundary changed after resolving ${packageJsonPath}; ` +
          'clear the Webpack resolver/module cache and rebuild.',
      }
    }
    const config = readFictPackageConfig(packageData)
    if (!config?.hasValidDeclaration) {
      const explicitlyConfigured =
        !!packageData &&
        typeof packageData === 'object' &&
        !Array.isArray(packageData) &&
        Object.prototype.hasOwnProperty.call(packageData, 'fict')
      return explicitlyConfigured ? { kind: 'unresolved' } : { kind: 'plain' }
    }
    if (resolution.publicSubpath === null) return { kind: 'plain' }
    const metadataPath = Object.prototype.hasOwnProperty.call(
      config.exports ?? {},
      resolution.publicSubpath,
    )
      ? config.exports?.[resolution.publicSubpath]
      : resolution.publicSubpath === '.'
        ? config.metadata
        : undefined
    if (metadataPath === null) return { kind: 'unresolved' }
    if (metadataPath === undefined) return { kind: 'plain' }

    const normalizedMetadataPath = normalizeMetadataPath(packageDir, metadataPath)
    if (!normalizedMetadataPath) return { kind: 'unresolved' }
    const realMetadataPath = resolveContainedFile(packageRoot, normalizedMetadataPath)
    if (realMetadataPath === undefined) {
      onDependency(normalizedMetadataPath)
      return { kind: 'unresolved' }
    }
    if (realMetadataPath === null) return { kind: 'unresolved' }
    onDependency(normalizedMetadataPath)
    const metadata = parseModuleReactiveMetadata(readFileSync(realMetadataPath, 'utf8'))
    return metadata ? { kind: 'resolved', metadata } : { kind: 'unresolved' }
  } catch {
    return { kind: 'unresolved' }
  }
}
